import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CURSOR_MCP_OWNER_ENV,
  CURSOR_MCP_SERVER_NAME,
  buildCursorMcpEntry,
  disableCursorMcp,
  enableCursorMcp,
  readCursorMcpState,
} from "../../../src/integrations/cursor-config";
import {
  createCursorMcpServer,
  cursorMcpToolDefinitions,
  handleCursorMcpToolCall,
  resolveCursorMcpAdmissionKey,
  resolveCursorMcpOptions,
} from "../../../src/integrations/cursor-mcp";

let tmpBase = "";
let mcpPath = "";

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "ocx-cursor-"));
  // Put the file one level down so the "Cursor config dir exists" check is false
  // until we create the file.
  mcpPath = join(tmpBase, "cursor", "mcp.json");
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("cursor-config", () => {
  test("read absent file reports not enabled", () => {
    const state = readCursorMcpState(mcpPath);
    expect(state.enabled).toBe(false);
    expect(state.kind).toBe("absent");
    expect(state.installed).toBe(false);
    expect(state.configPath).toBe(mcpPath);
  });

  test("enable creates the mcp.json entry", () => {
    const state = enableCursorMcp(10100, mcpPath);
    expect(state.enabled).toBe(true);
    expect(existsSync(mcpPath)).toBe(true);
    const text = readFileSync(mcpPath, "utf8");
    expect(text).toContain(CURSOR_MCP_SERVER_NAME);
    expect(text).toContain("10100");
    const written = JSON.parse(text) as { mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }> };
    const entry = written.mcpServers[CURSOR_MCP_SERVER_NAME]!;
    expect(entry.args).toContain("serve");
    expect(entry.env?.[CURSOR_MCP_OWNER_ENV]).toBe("opencodex");
    expect(text).not.toContain("ocx_admin_");
  });

  test("enable preserves unrelated servers", () => {
    const other = { mcpServers: { other: { command: "uvx", args: ["other"], env: { FOO: "bar" } } } };
    const text = JSON.stringify(other, null, 2);
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, text);

    enableCursorMcp(10100, mcpPath);
    const after = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    expect(after.mcpServers).toHaveProperty("other");
    expect(after.mcpServers).toHaveProperty(CURSOR_MCP_SERVER_NAME);
  });

  test("disable removes only the opencodex entry", () => {
    enableCursorMcp(10100, mcpPath);
    const state = disableCursorMcp(mcpPath);
    expect(state.enabled).toBe(false);
    const after = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    expect(after.mcpServers).toBeUndefined();
  });

  test("disable on absent file is a no-op", () => {
    const state = disableCursorMcp(mcpPath);
    expect(state.enabled).toBe(false);
    expect(existsSync(mcpPath)).toBe(false);
  });

  test("enable and disable refuse a same-named user-owned entry", () => {
    const original = JSON.stringify({ mcpServers: { opencodex: { command: "my-server", args: [] } } }, null, 2);
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, original);

    expect(() => enableCursorMcp(10100, mcpPath)).toThrow(/user-owned/);
    expect(() => disableCursorMcp(mcpPath)).toThrow(/user-owned/);
    expect(readFileSync(mcpPath, "utf8")).toBe(original);
    expect(readCursorMcpState(mcpPath).kind).toBe("foreign");
  });

  test("malformed JSON is never replaced", () => {
    const original = "{ not json\n";
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, original);

    expect(() => enableCursorMcp(10100, mcpPath)).toThrow(/not valid JSON/);
    expect(readFileSync(mcpPath, "utf8")).toBe(original);
    expect(readCursorMcpState(mcpPath).kind).toBe("invalid");
  });

  test("entry re-enters the supported CLI surface instead of executing a source module directly", () => {
    const entry = buildCursorMcpEntry(20202);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual(expect.arrayContaining(["integration", "cursor", "serve", "--port", "20202"]));
    expect(entry.args?.some(arg => arg.endsWith("cursor-mcp.ts"))).toBe(false);
  });
});

describe("cursor-mcp options", () => {
  test("defaults to port 10100", () => {
    const opts = resolveCursorMcpOptions([], {});
    expect(opts.port).toBeUndefined();
  });

  test("reads --port from argv", () => {
    const opts = resolveCursorMcpOptions(["node", "cursor-mcp", "--port", "20202"], {});
    expect(opts.port).toBe(20202);
  });

  test("reads OCX_CURSOR_MCP_PORT from env", () => {
    const opts = resolveCursorMcpOptions([], { OCX_CURSOR_MCP_PORT: "30303" });
    expect(opts.port).toBe(30303);
  });

  test("ignores malformed port values", () => {
    const opts = resolveCursorMcpOptions(["--port", "abc"], { OCX_CURSOR_MCP_PORT: "xyz" });
    expect(opts.port).toBeUndefined();
  });

  test("resolves data admission without treating OPENAI_API_KEY as a proxy credential", () => {
    const key = resolveCursorMcpAdmissionKey(
      { OPENAI_API_KEY: "upstream-secret" },
      [{ key: "ocx-data-key" }],
    );
    expect(key).toBe("ocx-data-key");
  });
});

describe("cursor-mcp server", () => {
  test("lists tools", () => {
    const tools = cursorMcpToolDefinitions();
    const names = tools.map(t => t.name);
    expect(names).toContain("list_available_models");
    expect(names).toContain("complete_via_opencodex");
    expect(names).toContain("list_codex_accounts");
    expect(names).toContain("pin_codex_account");
    expect(names).toContain("use_automatic_codex_rotation");
    expect(names).toContain("get_codex_usage");
    expect(names).toContain("get_codex_reset_credits");
  });

  test("createCursorMcpServer returns a server", () => {
    const server = createCursorMcpServer({ port: 10100 });
    expect(server).toBeDefined();
  });

  test("list_available_models forwards to proxy /v1/models", async () => {
    const models = { object: "list", data: [{ id: "openai/gpt-4o" }] };
    const fetch = (_url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      return Promise.resolve(new Response(JSON.stringify(models), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const result = await handleCursorMcpToolCall("list_available_models", {}, { port: 10100, fetch });
    expect(result.content).toHaveLength(1);
    const first = result.content[0] as { type: string; text: string };
    expect(first.type).toBe("text");
    expect(JSON.parse(first.text)).toEqual(models);
  });

  test("complete_via_opencodex forwards non-streaming request", async () => {
    const completion = { choices: [{ message: { content: "hello" } }] };
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedHeaders: Headers | undefined;
    const fetch = (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      capturedHeaders = new Headers(init.headers);
      return Promise.resolve(new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const result = await handleCursorMcpToolCall(
      "complete_via_opencodex",
      {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      },
      { port: 10100, apiKey: "admission-key", fetch },
    );
    expect(capturedUrl).toBe("http://127.0.0.1:10100/v1/chat/completions");
    expect(JSON.parse(capturedBody!)).toEqual({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(capturedHeaders!.get("x-opencodex-api-key")).toBe("admission-key");
    expect(capturedHeaders!.has("authorization")).toBe(false);
    const first = result.content[0] as { type: string; text: string };
    expect(first.text).toBe("hello");
  });

  test("rejects complete_via_opencodex without model", async () => {
    await expect(handleCursorMcpToolCall(
      "complete_via_opencodex",
      { messages: [{ role: "user", content: "hi" }] },
      { port: 10100 },
    )).rejects.toThrow(/model/);
  });

  test("lists privacy-safe account, active pin, and quota status through management routes", async () => {
    const seen = new Set<string>();
    const fetch = (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      seen.add(path);
      expect(new Headers(init.headers).get("x-opencodex-api-key")).toBe("admin-key");
      const body = path.endsWith("/accounts")
        ? { accounts: [{ id: "acct_1", email: "t***@example.com" }] }
        : path.endsWith("/active")
          ? { activeCodexAccountId: "acct_1", pinnedAccountId: "acct_1" }
          : { quotas: { acct_1: { primary: { resetsAt: 123 } } } };
      return Promise.resolve(Response.json(body));
    };
    const result = await handleCursorMcpToolCall("list_codex_accounts", {}, { port: 10100, adminToken: "admin-key", fetch });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.accounts.accounts[0].email).toBe("t***@example.com");
    expect(body.active.pinnedAccountId).toBe("acct_1");
    expect(body.quotas.quotas.acct_1.primary.resetsAt).toBe(123);
    expect(seen).toEqual(new Set([
      "/api/codex-auth/accounts",
      "/api/codex-auth/active",
      "/api/codex-auth/quota",
    ]));
  });

  test("pins an account and returns to automatic rotation", async () => {
    const bodies: unknown[] = [];
    const fetch = (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(Response.json({ ok: true, appliesImmediately: true }));
    };
    await handleCursorMcpToolCall("pin_codex_account", { account_id: "acct_1" }, { port: 10100, adminToken: "admin-key", fetch });
    await handleCursorMcpToolCall("use_automatic_codex_rotation", {}, { port: 10100, adminToken: "admin-key", fetch });
    expect(bodies).toEqual([{ accountId: "acct_1" }, { accountId: null }]);
  });

  test("reads Codex usage and reset timing without consuming credits", async () => {
    const seen: string[] = [];
    const fetch = (url: string) => {
      seen.push(url);
      return Promise.resolve(Response.json({ ok: true }));
    };
    await handleCursorMcpToolCall("get_codex_usage", { range: "7d" }, { port: 10100, adminToken: "admin-key", fetch });
    await handleCursorMcpToolCall("get_codex_reset_credits", { account_id: "acct/1" }, { port: 10100, adminToken: "admin-key", fetch });
    expect(seen[0]).toContain("/api/usage?range=7d&surface=codex");
    expect(seen[1]).toContain("/api/codex-auth/reset-credits?accountId=acct%2F1");
    expect(seen.some(url => url.includes("consume"))).toBe(false);
  });
});
