import { stripMachineAuthHeaders } from "./machine-auth";

export interface HubRelayTarget {
  managementUrl: string;
  browserOrigin: string;
}

export const HUB_RELAY_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const HUB_RELAY_RESPONSE_BODY_MAX_BYTES = 16 * 1024 * 1024;
export const HUB_RELAY_DEFAULT_TIMEOUT_MS = 15_000;
export const HUB_RELAY_HEADER_MAX_BYTES = 64 * 1024;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "origin",
  "x-opencodex-api-key",
  "x-opencodex-csrf-token",
  "x-opencodex-gui-origin",
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "pragma",
  "retry-after",
  "vary",
]);

function relayError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function relayDestination(suffix: string, target: HubRelayTarget, method: string): URL | null {
  const origin = canonicalOrigin(target.managementUrl);
  const browserOrigin = canonicalOrigin(target.browserOrigin);
  if (!origin || !browserOrigin || !ALLOWED_METHODS.has(method)) return null;
  if (!suffix.startsWith("/") || suffix.startsWith("//") || suffix.includes("\\") || suffix.includes("#")) return null;
  if (/%(?:2f|5c)/i.test(suffix) || /%(?:2e)(?:%2e|\.)?/i.test(suffix)) return null;
  const rawPath = suffix.split("?", 1)[0]!;
  for (const segment of rawPath.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
  }
  if (rawPath === "/opencodex-session") {
    if (suffix !== rawPath || (method !== "GET" && method !== "POST")) return null;
  } else if (!rawPath.startsWith("/api/")) {
    return null;
  }
  let destination: URL;
  try { destination = new URL(suffix, `${origin}/`); } catch { return null; }
  if (destination.origin !== origin || destination.username || destination.password || destination.hash) return null;
  if (destination.pathname !== rawPath) return null;
  return destination;
}

async function boundedBody(
  stream: ReadableStream<Uint8Array> | null,
  declared: string | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return null;
  const contentLength = declared === null ? null : Number(declared);
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > limit)) {
    throw new RangeError("body_too_large");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new RangeError("body_too_large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  // BodyInit requires an ArrayBuffer-backed view, not a SharedArrayBuffer-capable view.
  const body: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function filteredHeaders(source: Headers, allowlist: Set<string>): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (allowlist.has(name.toLowerCase())) headers.append(name, value);
  }
  return headers;
}

function headersWithinLimit(headers: Headers): boolean {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += name.length + value.length + 4;
    if (bytes > HUB_RELAY_HEADER_MAX_BYTES) return false;
  }
  return true;
}

export async function relayHubManagementRequest(
  req: Request,
  suffix: string,
  target: HubRelayTarget,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const method = req.method.toUpperCase();
  const destination = relayDestination(suffix, target, method);
  if (!destination) return relayError(404, "hub relay path refused");

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = method === "GET" || method === "HEAD"
      ? null
      : await boundedBody(req.body, req.headers.get("content-length"), HUB_RELAY_REQUEST_BODY_MAX_BYTES);
  } catch {
    return relayError(413, "hub relay request body too large");
  }

  const stripped = stripMachineAuthHeaders(req.headers);
  const headers = filteredHeaders(stripped, REQUEST_HEADERS);
  if (!headersWithinLimit(headers)) return relayError(431, "hub relay request headers too large");
  const browserOrigin = canonicalOrigin(target.browserOrigin);
  const mutation = method !== "GET" && method !== "HEAD";
  const suppliedOrigin = headers.get("origin");
  if (!browserOrigin || (mutation ? suppliedOrigin !== browserOrigin : suppliedOrigin !== null && suppliedOrigin !== browserOrigin)) {
    return relayError(403, "hub relay browser origin refused");
  }

  const timeoutMs = typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? Math.min(Math.floor(deps.timeoutMs), 120_000)
    : HUB_RELAY_DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = req.signal
    ? AbortSignal.any([req.signal, timeoutSignal])
    : timeoutSignal;
  let upstream: Response;
  try {
    upstream = await (deps.fetchImpl ?? fetch)(destination, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal,
    });
  } catch {
    return relayError(502, "hub relay unavailable");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay redirect refused");
  }

  let responseBody: Uint8Array<ArrayBuffer> | null;
  const responseHeaders = filteredHeaders(upstream.headers, RESPONSE_HEADERS);
  if (!headersWithinLimit(responseHeaders)) {
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay response headers too large");
  }
  try {
    responseBody = method === "HEAD"
      ? null
      : await boundedBody(upstream.body, upstream.headers.get("content-length"), HUB_RELAY_RESPONSE_BODY_MAX_BYTES);
  } catch {
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay response body too large");
  }
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
