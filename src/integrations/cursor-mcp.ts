/**
 * OpenCodex MCP server for the Cursor editor.
 *
 * Cursor's native Agent inference is not replaced by an MCP server. This
 * standalone server instead exposes explicit OpenCodex-routed completion tools
 * through Cursor's documented `~/.cursor/mcp.json` surface.
 *
 * The server speaks stdio (the only transport Cursor's mcp.json supports) and
 * forwards tool calls to the OpenCodex proxy at `http://127.0.0.1:<port>/v1`.
 * Calls to those tools participate in OpenCodex account rotation, routing
 * profiles, and provider selection. The Cursor Agent decides when to call a
 * tool (and asks for approval unless the user changes Cursor's tool policy).
 *
 * What this does NOT do:
 *   - Route Cursor's native Agent/Composer inference, Tab, indexing, auth,
 *     updates, or telemetry.
 *   - Intercept network traffic. Only the explicit MCP tools reach OpenCodex.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config";
import { loadAdminTokenFromFile } from "../lib/admin-secrets";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "../lib/service-secrets";

const DEFAULT_PORT = 10100;

export interface CursorMcpServerOptions {
  /** Proxy port. */
  port?: number;
  /** Loopback hostname. */
  hostname?: string;
  /** Admission key for the proxy, if required. */
  apiKey?: string;
  /** Test seam for management admission. Production reads the protected file per call. */
  adminToken?: string;
  /** Optional log sink; secrets are never logged. */
  log?: (message: string) => void;
  /** Test seam: override global fetch. */
  fetch?: typeof fetch;
}

interface CompleteToolArgs {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
}

type UsageRange = "today" | "7d" | "30d" | "all";

function baseUrl(options: CursorMcpServerOptions): string {
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? "127.0.0.1";
  return `http://${hostname}:${port}`;
}

function completionUrl(options: CursorMcpServerOptions): string {
  return `${baseUrl(options)}/v1/chat/completions`;
}

function modelsUrl(options: CursorMcpServerOptions): string {
  return `${baseUrl(options)}/v1/models`;
}

function requestHeaders(options: CursorMcpServerOptions): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (options.apiKey) {
    // Chat Completions reserves Authorization for an upstream credential and
    // admits the proxy's own key only through this dedicated header.
    headers.set("x-opencodex-api-key", options.apiKey);
  }
  return headers;
}

function managementHeaders(options: CursorMcpServerOptions): Headers {
  // Read at call time so rotating the protected admin token does not require
  // rewriting Cursor's config or restarting its MCP child.
  const token = options.adminToken?.trim() || loadAdminTokenFromFile();
  if (!token) {
    throw new McpError(ErrorCode.InternalError, "OpenCodex management token is unavailable; run OpenCodex once and retry.");
  }
  return new Headers({
    "content-type": "application/json",
    "x-opencodex-api-key": token,
  });
}

async function proxyJson(
  path: string,
  init: RequestInit,
  options: CursorMcpServerOptions,
  management = false,
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(`${baseUrl(options)}${path}`, {
    ...init,
    headers: management ? managementHeaders(options) : requestHeaders(options),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new McpError(ErrorCode.InternalError, `OpenCodex request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return await res.json();
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  return undefined;
}

/** Build options from CLI arguments and environment without logging secrets. */
export function resolveCursorMcpOptions(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): CursorMcpServerOptions {
  const args = [...argv];
  let port = parsePort(env.OCX_CURSOR_MCP_PORT);
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === "--port" || args[i] === "-p") && i + 1 < args.length) {
      const parsed = parsePort(args[i + 1]);
      if (parsed !== undefined) port = parsed;
    }
  }
  return {
    port,
    hostname: env.OCX_CURSOR_MCP_HOSTNAME,
    apiKey: env.OCX_CURSOR_MCP_API_KEY || undefined,
  };
}

/**
 * Resolve local data-plane admission without serializing a reusable key into
 * Cursor's JSON file. This process runs as the same OS user as OpenCodex and
 * reads the same protected sources as the other local launchers.
 */
export function resolveCursorMcpAdmissionKey(
  env: NodeJS.ProcessEnv = process.env,
  configuredKeys: readonly { key: string }[] | undefined = loadConfig().apiKeys,
): string | undefined {
  const inline = env.OPENCODEX_API_AUTH_TOKEN?.trim() || env.OCX_CURSOR_MCP_API_KEY?.trim();
  if (inline) return inline;
  const tokenFileEnv = env.OCX_API_TOKEN_FILE?.trim()
    ? env
    : { ...env, OCX_API_TOKEN_FILE: serviceApiTokenFilePath() };
  const fileToken = loadServiceTokenFromFile(tokenFileEnv);
  if (fileToken) return fileToken;
  return configuredKeys?.find(entry => entry.key.trim().length > 0)?.key.trim() || undefined;
}

async function fetchAvailableModels(options: CursorMcpServerOptions): Promise<unknown> {
  return proxyJson(new URL(modelsUrl(options)).pathname, { method: "GET" }, options);
}

async function fetchCodexAccountStatus(options: CursorMcpServerOptions): Promise<unknown> {
  const [accounts, active, quotas] = await Promise.all([
    proxyJson("/api/codex-auth/accounts", { method: "GET" }, options, true),
    proxyJson("/api/codex-auth/active", { method: "GET" }, options, true),
    proxyJson("/api/codex-auth/quota", { method: "GET" }, options, true),
  ]);
  return { accounts, active, quotas };
}

async function selectCodexAccount(accountId: string | null, options: CursorMcpServerOptions): Promise<unknown> {
  return proxyJson("/api/codex-auth/active", {
    method: "PUT",
    body: JSON.stringify({ accountId }),
  }, options, true);
}

async function fetchCodexUsage(range: UsageRange, options: CursorMcpServerOptions): Promise<unknown> {
  return proxyJson(`/api/usage?range=${encodeURIComponent(range)}&surface=codex`, { method: "GET" }, options, true);
}

async function fetchCodexResetCredits(accountId: string, options: CursorMcpServerOptions): Promise<unknown> {
  return proxyJson(
    `/api/codex-auth/reset-credits?accountId=${encodeURIComponent(accountId)}`,
    { method: "GET" },
    options,
    true,
  );
}

async function completeViaOpenCodex(args: CompleteToolArgs, options: CursorMcpServerOptions): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const body = {
    model: args.model,
    messages: args.messages,
    stream: false,
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
  };
  const res = await doFetch(completionUrl(options), {
    method: "POST",
    headers: requestHeaders(options),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new McpError(ErrorCode.InternalError, `Proxy completion failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : JSON.stringify(json, null, 2);
}

/** Tool metadata advertised by the Cursor MCP server. */
export function cursorMcpToolDefinitions() {
  return [
    {
      name: "list_available_models",
      description:
        "List the models currently available through the local OpenCodex proxy. "
        + "Returns OpenAI-compatible /v1/models data including provider-qualified routed ids.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "complete_via_opencodex",
      description:
        "Request a chat completion through the local OpenCodex proxy. "
        + "This explicit MCP tool call, not Cursor's own Agent inference, uses OpenCodex account/provider rotation. "
        + "model must be an id returned by list_available_models.",
      inputSchema: {
        type: "object",
        properties: {
          model: { type: "string", description: "Model id (e.g. openai/gpt-4o)." },
          messages: {
            type: "array",
            description: "OpenAI chat messages array.",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant"] },
                content: { type: "string" },
              },
              required: ["role", "content"],
            },
          },
          temperature: { type: "number" },
          max_tokens: { type: "integer" },
        },
        required: ["model", "messages"],
      },
    },
    {
      name: "list_codex_accounts",
      description:
        "List OpenCodex's privacy-safe Codex account status, active/pinned selection, quota, and reset timing. "
        + "Emails are masked by the OpenCodex management API and credentials are never returned.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "pin_codex_account",
      description:
        "Pin subsequent OpenCodex Codex-model requests to one account immediately. "
        + "Use an opaque account_id returned by list_codex_accounts. This affects OpenCodex-routed clients, not Cursor's native inference.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Opaque OpenCodex Codex account id." },
        },
        required: ["account_id"],
      },
    },
    {
      name: "use_automatic_codex_rotation",
      description:
        "Release the manual Codex account pin and return OpenCodex-routed requests to the configured automatic pool strategy. "
        + "This does not change Cursor's native inference account.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_codex_usage",
      description:
        "Return privacy-safe OpenCodex Codex usage totals and per-model breakdowns for a time range. Prompts are never included.",
      inputSchema: {
        type: "object",
        properties: {
          range: { type: "string", enum: ["today", "7d", "30d", "all"], description: "Usage window; defaults to today." },
        },
        required: [],
      },
    },
    {
      name: "get_codex_reset_credits",
      description:
        "Read reset-credit availability and timing for one OpenCodex Codex account. This tool never consumes a reset credit.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Opaque OpenCodex Codex account id." },
        },
        required: ["account_id"],
      },
    },
  ];
}

/** Execute one Cursor MCP tool call against the local OpenCodex proxy. */
export async function handleCursorMcpToolCall(
  toolName: string,
  arguments_: Record<string, unknown> | undefined,
  options: CursorMcpServerOptions,
): Promise<{ content: TextContent[] }> {
  if (toolName === "list_available_models") {
    const models = await fetchAvailableModels(options);
    const content: TextContent = { type: "text", text: JSON.stringify(models, null, 2) };
    return { content: [content] };
  }
  if (toolName === "complete_via_opencodex") {
    const args = arguments_ as unknown as CompleteToolArgs;
    if (typeof args.model !== "string" || args.model === "") {
      throw new McpError(ErrorCode.InvalidParams, "complete_via_opencodex requires a non-empty model string");
    }
    if (!Array.isArray(args.messages) || args.messages.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "complete_via_opencodex requires a non-empty messages array");
    }
    const validMessages = args.messages.every(message =>
      message !== null
      && typeof message === "object"
      && ["system", "user", "assistant"].includes(message.role)
      && typeof message.content === "string"
    );
    if (!validMessages) {
      throw new McpError(ErrorCode.InvalidParams, "complete_via_opencodex messages require a supported role and string content");
    }
    const result = await completeViaOpenCodex(args, options);
    const content: TextContent = { type: "text", text: result };
    return { content: [content] };
  }
  if (toolName === "list_codex_accounts") {
    const result = await fetchCodexAccountStatus(options);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (toolName === "pin_codex_account") {
    const accountId = arguments_?.account_id;
    if (typeof accountId !== "string" || accountId.trim() === "") {
      throw new McpError(ErrorCode.InvalidParams, "pin_codex_account requires a non-empty account_id");
    }
    const result = await selectCodexAccount(accountId.trim(), options);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (toolName === "use_automatic_codex_rotation") {
    const result = await selectCodexAccount(null, options);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (toolName === "get_codex_usage") {
    const requestedRange = arguments_?.range ?? "today";
    if (!["today", "7d", "30d", "all"].includes(String(requestedRange))) {
      throw new McpError(ErrorCode.InvalidParams, "get_codex_usage range must be today, 7d, 30d, or all");
    }
    const result = await fetchCodexUsage(requestedRange as UsageRange, options);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (toolName === "get_codex_reset_credits") {
    const accountId = arguments_?.account_id;
    if (typeof accountId !== "string" || accountId.trim() === "") {
      throw new McpError(ErrorCode.InvalidParams, "get_codex_reset_credits requires a non-empty account_id");
    }
    const result = await fetchCodexResetCredits(accountId.trim(), options);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
}

/** Create an MCP server wired to the local OpenCodex proxy. */
export function createCursorMcpServer(options: CursorMcpServerOptions = {}): Server {
  const log = options.log ?? (() => {});
  const server = new Server(
    { name: "opencodex-cursor", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cursorMcpToolDefinitions() }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const toolName = request.params.name;
    log(`[cursor-mcp] tool call: ${toolName}`);
    try {
      return await handleCursorMcpToolCall(toolName, request.params.arguments ?? {}, options);
    } catch (error) {
      if (error instanceof McpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  return server;
}

/** Start the stdio server. Returns a promise that resolves when the transport closes. */
export async function runCursorMcpServer(options: CursorMcpServerOptions = {}): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message));
  const server = createCursorMcpServer(options);
  const transport = new StdioServerTransport();
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const closeOnInputEnd = () => { void transport.close(); };
  process.stdin.once("end", closeOnInputEnd);
  server.onclose = () => {
    process.stdin.off("end", closeOnInputEnd);
    resolveClosed();
  };
  await server.connect(transport);
  log(`[cursor-mcp] connected to OpenCodex proxy at ${baseUrl(options)}`);
  // `Server.connect()` resolves after attaching the transport. The normal CLI
  // dispatcher calls process.exit when its command returns, so remain here
  // until Cursor closes stdin/the transport instead of killing the MCP server
  // immediately after initialization.
  await closed;
}

if (import.meta.main) {
  const options = resolveCursorMcpOptions();
  options.apiKey ??= resolveCursorMcpAdmissionKey();
  runCursorMcpServer(options).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cursor-mcp] fatal: ${message}`);
    process.exit(1);
  });
}
