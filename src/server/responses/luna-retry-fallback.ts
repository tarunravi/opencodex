/**
 * One-shot per-request fallback to Codex Luna XHigh.
 *
 * When a request fails with a retryable upstream error and every normal
 * candidate is exhausted, retry the SAME request once against
 * `openai/gpt-5.6-luna` at `xhigh` reasoning effort. Nothing is persisted:
 * no cooldown is written and no config is mutated, so the NEXT request
 * routes to its original model again as if nothing happened.
 */
export const LUNA_RETRY_FALLBACK_PROVIDER = "openai";
export const LUNA_RETRY_FALLBACK_MODEL = "gpt-5.6-luna";
export const LUNA_RETRY_FALLBACK_EFFORT = "xhigh";
export const LUNA_RETRY_FALLBACK_MODEL_ID = `${LUNA_RETRY_FALLBACK_PROVIDER}/${LUNA_RETRY_FALLBACK_MODEL}`;

/**
 * Narrow retryable rule for the Luna net. Deliberately stricter than combo
 * traversal: only transient failures (rate limits, timeouts, 5xx) cross to a
 * different model. Auth/route/client errors (401/403/404/...) never do -- a
 * 404 means the request itself is unroutable and retrying Luna would mask a
 * client config error (or misroute through the default provider).
 */
const LUNA_RETRYABLE_CODES = new Set([
  "rate_limit_exceeded",
  "server_is_overloaded",
  "upstream_server_error",
]);

export function isLunaRetryableFailure(status: number, code?: string | null): boolean {
  if (status === 429 || status === 408 || status >= 500) return true;
  if (typeof code === "string" && LUNA_RETRYABLE_CODES.has(code)) return true;
  return false;
}

export function lunaRetryFallbackKey(): string {
  return `${LUNA_RETRY_FALLBACK_PROVIDER}\u0000${LUNA_RETRY_FALLBACK_MODEL}`;
}

/** True when `model` (bare or provider-qualified) already targets Luna. */
export function isLunaRetryFallbackModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const bare = model.trim().toLowerCase().split("/").pop() ?? "";
  return bare === LUNA_RETRY_FALLBACK_MODEL;
}

export function isLunaRetryFallbackTarget(target: { provider: string; model: string }): boolean {
  return target.provider === LUNA_RETRY_FALLBACK_PROVIDER
    && target.model === LUNA_RETRY_FALLBACK_MODEL;
}

function reasoningEffortOf(body: Record<string, unknown>): string | undefined {
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as Record<string, unknown>).effort;
    return typeof effort === "string" ? effort : undefined;
  }
  return undefined;
}

/** Skip when the failed attempt was ALREADY Luna at XHigh -- retrying would loop. */
export function isAlreadyLunaXhighAttempt(rawBody: Record<string, unknown>): boolean {
  return isLunaRetryFallbackModel(rawBody.model)
    && reasoningEffortOf(rawBody)?.toLowerCase() === LUNA_RETRY_FALLBACK_EFFORT;
}

/** Opt-out via `{ "lunaRetryFallback": false }` in config or OPENCODEX_DISABLE_LUNA_RETRY_FALLBACK=1. */
export function isLunaRetryFallbackDisabled(config: unknown): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
    if (env?.OPENCODEX_DISABLE_LUNA_RETRY_FALLBACK === "1") return true;
  } catch {
    /* non-node runtime: ignore env */
  }
  if (config && typeof config === "object" && !Array.isArray(config)) {
    if ((config as Record<string, unknown>).lunaRetryFallback === false) return true;
  }
  return false;
}

/**
 * The Codex-login pool provider must exist and not be disabled. An absent
 * `providers` map (unit tests passing `{}` as config) counts as usable so the
 * fallback stays testable without a full production config.
 */
export function isLunaRetryFallbackProviderUsable(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return true;
  const providers = (config as { providers?: Record<string, { disabled?: boolean }> }).providers;
  if (!providers || typeof providers !== "object") return true;
  // A concrete providers map without the Codex-login pool means Luna cannot
  // serve the retry (and must not misroute through the default provider).
  if (!Object.hasOwn(providers, LUNA_RETRY_FALLBACK_PROVIDER)) return false;
  return providers[LUNA_RETRY_FALLBACK_PROVIDER]?.disabled !== true;
}

/** Rewrite a Responses-shaped body onto Luna XHigh, preserving all other fields. */
export function lunaRetryFallbackBody(rawBody: Record<string, unknown>): Record<string, unknown> {
  const reasoning = rawBody.reasoning && typeof rawBody.reasoning === "object" && !Array.isArray(rawBody.reasoning)
    ? { ...(rawBody.reasoning as Record<string, unknown>) }
    : {};
  return {
    ...rawBody,
    model: LUNA_RETRY_FALLBACK_MODEL_ID,
    reasoning: { ...reasoning, effort: LUNA_RETRY_FALLBACK_EFFORT },
    ...(Array.isArray(rawBody.input) ? { input: sanitizeInputForCrossProviderReplay(rawBody.input) } : {}),
  };
}

/** Keep an explicit Luna combo backup on the same XHigh safety-net contract. */
export function applyLunaRetryFallbackEffort(
  rawBody: Record<string, unknown>,
  target: { provider: string; model: string },
): void {
  if (!isLunaRetryFallbackTarget(target)) return;
  const reasoning = rawBody.reasoning && typeof rawBody.reasoning === "object" && !Array.isArray(rawBody.reasoning)
    ? rawBody.reasoning as Record<string, unknown>
    : {};
  rawBody.reasoning = { ...reasoning, effort: LUNA_RETRY_FALLBACK_EFFORT };
}

/**
 * Provider-specific reasoning carryover (`thinking` / `reasoning` items and
 * `signature` / `thought_signature` / `thoughtSignature` blobs) is rejected by
 * a different backend. Strip it so a cross-provider replay stays servable;
 * user, assistant, and tool content is preserved.
 */
const LUNA_RETRY_STRIPPED_KEYS = new Set(["signature", "thought_signature", "thoughtSignature"]);

function stripSignatureFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSignatureFields);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (LUNA_RETRY_STRIPPED_KEYS.has(key)) continue;
      out[key] = stripSignatureFields(entry);
    }
    return out;
  }
  return value;
}

/** Shared cross-provider cleaner: also used for combo hops onto non-Google targets. */
export function sanitizeInputForCrossProviderReplay(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const cleaned: unknown[] = [];
  for (const item of input) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const type = (item as Record<string, unknown>).type;
      if (type === "thinking" || type === "reasoning") continue;
    }
    cleaned.push(stripSignatureFields(item));
  }
  return cleaned;
}

export function requestWithLunaRetryFallback(req: Request, rawBody: Record<string, unknown>): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify(lunaRetryFallbackBody(rawBody)),
    signal: req.signal,
  });
}
