/**
 * Narrow, ownership-aware management of Cursor's global MCP file.
 *
 * Cursor documents `~/.cursor/mcp.json` as the supported global configuration
 * surface for local stdio MCP servers. OpenCodex owns only the entry carrying
 * `OCX_CURSOR_MCP_OWNER=opencodex`; a same-named entry without that marker is
 * user-owned and is never replaced or removed.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { selfLaunchArgv } from "../lib/self-launch-argv";

export const CURSOR_MCP_SERVER_NAME = "opencodex";
export const CURSOR_MCP_OWNER_ENV = "OCX_CURSOR_MCP_OWNER";
export const CURSOR_MCP_OWNER_VALUE = "opencodex";

export interface CursorMcpJsonEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface CursorMcpJson {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CursorMcpConfigKind = "absent" | "current" | "foreign" | "invalid" | "unreadable";

export interface CursorMcpConfigState {
  /** Absolute path to the file that was read or would be written. */
  configPath: string;
  /** Whether the OpenCodex-owned entry is present. */
  enabled: boolean;
  /** Whether Cursor's global config directory exists. */
  installed: boolean;
  /** Why the entry is or is not usable. */
  kind: CursorMcpConfigKind;
  /** Secret-free diagnostic suitable for management/CLI output. */
  message?: string;
  /** Present on mutations; omitted on inspection. */
  changed?: boolean;
}

export type CursorMcpConfigErrorReason = "foreign_entry" | "invalid_config" | "config_busy" | "write_failed";

export class CursorMcpConfigError extends Error {
  constructor(readonly reason: CursorMcpConfigErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CursorMcpConfigError";
  }
}

interface CursorMcpDocument {
  state: CursorMcpConfigState;
  value?: CursorMcpJson;
  original?: string;
}

let writeSequence = 0;

function defaultCursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOwnedEntry(value: unknown): value is CursorMcpJsonEntry {
  if (!isRecord(value)) return false;
  const env = value.env;
  return isRecord(env) && env[CURSOR_MCP_OWNER_ENV] === CURSOR_MCP_OWNER_VALUE;
}

function state(
  configPath: string,
  installed: boolean,
  kind: CursorMcpConfigKind,
  message?: string,
): CursorMcpConfigState {
  return {
    configPath,
    installed,
    enabled: kind === "current",
    kind,
    ...(message ? { message } : {}),
  };
}

function readCursorMcpDocument(configPath: string): CursorMcpDocument {
  const installed = existsSync(dirname(configPath));
  let stats;
  try {
    stats = lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: state(configPath, installed, "absent"), value: {} };
    }
    return {
      state: state(configPath, installed, "unreadable", "Cursor's MCP configuration could not be inspected safely."),
    };
  }

  if (!stats.isFile() || stats.isSymbolicLink()) {
    return {
      state: state(configPath, installed, "unreadable", "Cursor's MCP configuration is not a regular file."),
    };
  }

  let original: string;
  try {
    original = readFileSync(configPath, "utf8");
  } catch {
    return {
      state: state(configPath, installed, "unreadable", "Cursor's MCP configuration could not be read safely."),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    return {
      state: state(configPath, installed, "invalid", "Cursor's MCP configuration is not valid JSON; OpenCodex left it unchanged."),
      original,
    };
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    return {
      state: state(configPath, installed, "invalid", "Cursor's MCP configuration has an unsupported shape; OpenCodex left it unchanged."),
      original,
    };
  }

  const value = parsed as CursorMcpJson;
  const entry = value.mcpServers?.[CURSOR_MCP_SERVER_NAME];
  if (entry === undefined) return { state: state(configPath, installed, "absent"), value, original };
  if (isOwnedEntry(entry)) return { state: state(configPath, installed, "current"), value, original };
  return {
    state: state(
      configPath,
      installed,
      "foreign",
      `Cursor already has a user-owned "${CURSOR_MCP_SERVER_NAME}" MCP server; OpenCodex left it unchanged.`,
    ),
    value,
    original,
  };
}

function assertWritable(document: CursorMcpDocument): asserts document is CursorMcpDocument & { value: CursorMcpJson } {
  if (document.value) return;
  throw new CursorMcpConfigError(
    "invalid_config",
    document.state.message ?? "Cursor's MCP configuration could not be changed safely.",
  );
}

function currentBytes(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new CursorMcpConfigError("config_busy", "Cursor's MCP configuration changed while OpenCodex was preparing the update.");
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof CursorMcpConfigError) throw error;
    throw new CursorMcpConfigError("write_failed", "Cursor's MCP configuration could not be re-read before writing.", { cause: error });
  }
}

/**
 * Atomically replace mcp.json only if its bytes still match the inspected copy.
 * The temporary file may contain unrelated servers' environment values, so a
 * failed write is truncated before removal.
 */
function writeCursorMcpDocument(path: string, value: CursorMcpJson, expected: string | undefined): void {
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new CursorMcpConfigError("write_failed", "Cursor's MCP configuration directory could not be created.", { cause: error });
  }

  const temp = `${path}.opencodex.${process.pid}.${++writeSequence}.tmp`;
  let tempExists = false;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    tempExists = true;
    try { chmodSync(temp, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
    if (currentBytes(path) !== expected) {
      throw new CursorMcpConfigError("config_busy", "Cursor's MCP configuration changed while OpenCodex was preparing the update; retry the command.");
    }
    renameSync(temp, path);
    tempExists = false;
  } catch (error) {
    if (tempExists) {
      try { truncateSync(temp, 0); } catch { /* removal below is still attempted */ }
      try { unlinkSync(temp); } catch { /* surface the original error without printing file contents */ }
    }
    if (error instanceof CursorMcpConfigError) throw error;
    throw new CursorMcpConfigError("write_failed", "Cursor's MCP configuration could not be written.", { cause: error });
  }
}

/** Build the owned stdio entry. No reusable credential is serialized. */
export function buildCursorMcpEntry(port: number): CursorMcpJsonEntry {
  const sourceEntrypoint = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
  return {
    command: process.execPath,
    args: selfLaunchArgv(
      ["integration", "cursor", "serve", "--port", String(port)],
      { sourceEntrypoint },
    ),
    env: {
      [CURSOR_MCP_OWNER_ENV]: CURSOR_MCP_OWNER_VALUE,
      // A path to the protected service token is safe to persist; the token
      // itself is resolved only inside the local MCP child when needed.
      OCX_API_TOKEN_FILE: serviceApiTokenFilePath(),
    },
  };
}

/** Inspect Cursor's supported global MCP config without mutating it. */
export function readCursorMcpState(configPath = defaultCursorConfigPath()): CursorMcpConfigState {
  return readCursorMcpDocument(configPath).state;
}

/** Add or refresh only the OpenCodex-owned entry. */
export function enableCursorMcp(port: number, configPath = defaultCursorConfigPath()): CursorMcpConfigState {
  const document = readCursorMcpDocument(configPath);
  assertWritable(document);
  if (document.state.kind === "foreign") {
    throw new CursorMcpConfigError("foreign_entry", document.state.message ?? "Cursor's opencodex MCP name is already in use.");
  }
  const mcpServers = { ...(document.value.mcpServers ?? {}) };
  const nextEntry = buildCursorMcpEntry(port);
  if (document.state.kind === "current" && JSON.stringify(mcpServers[CURSOR_MCP_SERVER_NAME]) === JSON.stringify(nextEntry)) {
    return { ...document.state, changed: false };
  }
  mcpServers[CURSOR_MCP_SERVER_NAME] = nextEntry;
  writeCursorMcpDocument(configPath, { ...document.value, mcpServers }, document.original);
  return { ...readCursorMcpState(configPath), changed: true };
}

/** Remove only an entry carrying OpenCodex's ownership marker. */
export function disableCursorMcp(configPath = defaultCursorConfigPath()): CursorMcpConfigState {
  const document = readCursorMcpDocument(configPath);
  assertWritable(document);
  if (document.state.kind === "foreign") {
    throw new CursorMcpConfigError("foreign_entry", document.state.message ?? "Cursor's opencodex MCP name is user-owned.");
  }
  if (document.state.kind === "absent") return { ...document.state, changed: false };
  const mcpServers = { ...(document.value.mcpServers ?? {}) };
  delete mcpServers[CURSOR_MCP_SERVER_NAME];
  const next: CursorMcpJson = { ...document.value };
  if (Object.keys(mcpServers).length === 0) delete next.mcpServers;
  else next.mcpServers = mcpServers;
  writeCursorMcpDocument(configPath, next, document.original);
  return { ...readCursorMcpState(configPath), changed: true };
}
