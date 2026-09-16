import { open } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import type { UsageRange, UsageSurface } from "./summary";
import { projectRemoteUsageDetails } from "./remote-report";
import { parseUsageTimeWindow } from "./time-range";

export interface UsageRemote {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
}
export interface RemoteUsageQuery {
  range: UsageRange;
  surface: UsageSurface;
  since?: number;
  until?: number;
}
export interface RemoteUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}
export type RemoteUsageError = "unavailable" | "unauthorized" | "invalid_response" | "unsupported_window" | "timeout";
export interface RemoteUsageResult {
  id: string;
  name: string;
  usage?: { summary: RemoteUsageTotals; details?: Record<string, unknown>; historyTruncated?: boolean; usageIncomplete?: boolean; timeZone?: string };
  error?: RemoteUsageError;
}
export interface RemoteUsageResponse {
  remotes: RemoteUsageResult[];
  error?: "invalid_config";
}

const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const totalsKeys = ["requests", "inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"] as const;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const metric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseRemotes(value: unknown): UsageRemote[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("invalid_config");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id)
      || ids.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80
      || /[\x00-\x1f\x7f]/.test(entry.name) || typeof entry.token !== "string" || !entry.token
      || entry.token.length > 4096 || /[^\x21-\x7e]/.test(entry.token) || typeof entry.baseUrl !== "string") {
      throw new Error("invalid_config");
    }
    const url = new URL(entry.baseUrl);
    // SSH forwards keep remote credentials off both the browser and cleartext networks.
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid_config");
    ids.add(entry.id);
    return { id: entry.id, name: entry.name.trim(), baseUrl: url.origin, token: entry.token };
  });
}

export async function readUsageRemotes(configDir = getConfigDir()): Promise<UsageRemote[]> {
  let file;
  try {
    file = await open(join(configDir, "usage-remotes.json"), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("invalid_config");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("invalid_config");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error("invalid_config");
    return parseRemotes(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } catch {
    throw new Error("invalid_config");
  } finally {
    await file.close();
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("invalid_response");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function collectOne(remote: UsageRemote, query: RemoteUsageQuery, timeoutMs: number): Promise<RemoteUsageResult> {
  const result: RemoteUsageResult = { id: remote.id, name: remote.name };
  const url = new URL("/api/usage", remote.baseUrl);
  url.searchParams.set("range", query.range);
  url.searchParams.set("surface", query.surface);
  if (query.since !== undefined && query.until !== undefined) {
    url.searchParams.set("since", String(query.since));
    url.searchParams.set("until", String(query.until));
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "x-opencodex-api-key": remote.token },
      redirect: "error",
      proxy: "",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ...result, error: response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable" };
    }
    let body: unknown;
    try { body = await readResponse(response); }
    catch { return { ...result, error: signal.aborted ? "timeout" : "invalid_response" }; }
    if (!record(body) || body.error != null) return { ...result, error: "invalid_response" };
    if (query.since !== undefined && (body.customWindow !== true || body.since !== query.since || body.until !== query.until)) {
      return { ...result, error: "unsupported_window" };
    }
    if (body.range !== query.range || body.surface !== query.surface || !record(body.summary)) {
      return { ...result, error: "invalid_response" };
    }
    const summary = {} as RemoteUsageTotals;
    for (const key of totalsKeys) {
      const value = body.summary[key];
      if (!metric(value)) return { ...result, error: "invalid_response" };
      summary[key] = value;
    }
    if (body.summary.estimatedCostUsd !== undefined) {
      if (!metric(body.summary.estimatedCostUsd)) return { ...result, error: "invalid_response" };
      summary.estimatedCostUsd = body.summary.estimatedCostUsd;
    }
    const usage: NonNullable<RemoteUsageResult["usage"]> = { summary };
    for (const key of ["historyTruncated", "usageIncomplete"] as const) {
      if (typeof body[key] === "boolean") usage[key] = body[key];
    }
    if (typeof body.timeZone === "string" && /^[A-Za-z0-9_+./-]{1,80}$/.test(body.timeZone)) usage.timeZone = body.timeZone;
    try {
      const details = projectRemoteUsageDetails(body);
      if (details) usage.details = details;
    } catch { return { ...result, error: "invalid_response" }; }
    return { ...result, usage };
  } catch {
    return { ...result, error: signal.aborted ? "timeout" : "unavailable" };
  }
}

export async function collectRemoteUsage(
  query: RemoteUsageQuery,
  options: { configDir?: string; timeoutMs?: number } = {},
): Promise<RemoteUsageResponse> {
  parseUsageTimeWindow(query.since, query.until);
  let remotes: UsageRemote[];
  try { remotes = await readUsageRemotes(options.configDir); }
  catch { return { remotes: [], error: "invalid_config" }; }
  return { remotes: await Promise.all(remotes.map(remote => collectOne(remote, query, options.timeoutMs ?? 5000))) };
}
