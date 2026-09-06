import { describe, expect, test } from "bun:test";

import { formatErrorResponse } from "../src/bridge";
import type { OcxConfig } from "../src/types";
import { beginRequestAttempt, type RequestLogContext } from "../src/server/request-log";
import type { RouteDecisionTraceV1 } from "../src/routing/trace";
import { handleResponsesWithPolicyFallback } from "../src/server/responses/policy-fallback";
import {
  applyLunaRetryFallbackEffort,
  isAlreadyLunaXhighAttempt,
  isLunaRetryFallbackTarget,
  isLunaRetryFallbackModel,
  LUNA_RETRY_FALLBACK_MODEL_ID,
  lunaRetryFallbackBody,
  sanitizeInputForCrossProviderReplay,
} from "../src/server/responses/luna-retry-fallback";

function request(model: string, extraBody: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream: false, ...extraBody }),
  });
}

function seedAttempt(logCtx: RequestLogContext, provider: string, model: string): void {
  if (logCtx.activeAttempt) return;
  const attempt = beginRequestAttempt((logCtx.attempts?.length ?? 0) + 1, provider, model, "test");
  (logCtx.attempts ??= []).push(attempt);
  logCtx.activeAttempt = attempt;
  logCtx.activeAttemptStartedAt = Date.now();
}

function retryable(): Response {
  return formatErrorResponse(429, "rate_limit_exceeded", "Rate limit exceeded, please retry shortly.");
}

function terminal(): Response {
  return formatErrorResponse(400, "invalid_request_error", "Bad request: malformed input.");
}

function success(): Response {
  return Response.json({ id: "resp", object: "response", status: "completed", output: [] });
}

function singleCandidatePolicyTrace(): RouteDecisionTraceV1 {
  return {
    version: 1,
    decisionId: "decision-luna",
    createdAt: 1,
    requestedModel: "policy/daily",
    routeKind: "policy",
    profile: { id: "daily", revision: "rev-1" },
    requirements: [],
    candidates: [
      { provider: "provider-a", model: "model-a", eligible: true, exclusions: [], score: { total: 0.9, components: {} } },
    ],
    selected: { candidateIndex: 0, provider: "provider-a", model: "model-a", reason: "highest-score" },
  };
}

describe("luna retry fallback", () => {
  test("direct route falls back to Luna XHigh once on a retryable error", async () => {
    const logCtx = { requestedModel: "test-provider/test-model", attempts: [] } as unknown as RequestLogContext;
    const seen: Array<{ model: unknown; effort: unknown; input: unknown }> = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = (await req.clone().json()) as { model?: unknown; reasoning?: { effort?: unknown }; input?: unknown };
      seen.push({ model: body.model, effort: body.reasoning?.effort, input: body.input });
      seedAttempt(ctx, "provider", String(body.model));
      if (seen.length === 1) return retryable();
      return success();
    };

    const response = await handleResponsesWithPolicyFallback(request("test-provider/test-model"), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(200);
    expect(seen.map(s => s.model)).toEqual(["test-provider/test-model", LUNA_RETRY_FALLBACK_MODEL_ID]);
    expect(seen[1]?.effort).toBe("xhigh");
    expect(seen[1]?.input).toBe("hello");
    // Per-request only: logical identity is restored, nothing sticks for the next request.
    expect(logCtx.requestedModel).toBe("test-provider/test-model");
    expect(logCtx.routeDecision).toBeUndefined();
  });

  test("no Luna attempt for terminal errors", async () => {
    const logCtx = { requestedModel: "test-provider/test-model", attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const runCore = async (_req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      calls += 1;
      seedAttempt(ctx, "provider", "test-provider/test-model");
      return terminal();
    };

    const response = await handleResponsesWithPolicyFallback(request("test-provider/test-model"), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  test("no Luna loop when the failed attempt was already Luna XHigh", async () => {
    const logCtx = { requestedModel: LUNA_RETRY_FALLBACK_MODEL_ID, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const runCore = async (_req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      calls += 1;
      seedAttempt(ctx, "provider", LUNA_RETRY_FALLBACK_MODEL_ID);
      return retryable();
    };

    const response = await handleResponsesWithPolicyFallback(
      request(LUNA_RETRY_FALLBACK_MODEL_ID, { reasoning: { effort: "xhigh" } }),
      {} as OcxConfig,
      logCtx,
      {},
      { runCore },
    );

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  test("no Luna attempt when the Codex-login provider is disabled", async () => {
    const logCtx = { requestedModel: "test-provider/test-model", attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const runCore = async (_req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      calls += 1;
      seedAttempt(ctx, "provider", "test-provider/test-model");
      return retryable();
    };
    const config = { providers: { openai: { disabled: true } } } as unknown as OcxConfig;

    const response = await handleResponsesWithPolicyFallback(request("test-provider/test-model"), config, logCtx, {}, { runCore });

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  test("policy candidates exhaust first, then Luna XHigh", async () => {
    const trace = singleCandidatePolicyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = (await req.clone().json()) as { model?: string };
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      if (seenModels.length === 1) return retryable();
      return success();
    };

    const response = await handleResponsesWithPolicyFallback(request("policy/daily"), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(200);
    expect(seenModels).toEqual(["policy/daily", LUNA_RETRY_FALLBACK_MODEL_ID]);
    expect(logCtx.requestedModel).toBe("policy/daily");
    expect(logCtx.routeDecision).toBe(trace);
  });

  test("config opt-out disables the Luna attempt", async () => {
    const logCtx = { requestedModel: "test-provider/test-model", attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const runCore = async (_req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      calls += 1;
      seedAttempt(ctx, "provider", "test-provider/test-model");
      return retryable();
    };
    const config = { lunaRetryFallback: false } as unknown as OcxConfig;

    const response = await handleResponsesWithPolicyFallback(request("test-provider/test-model"), config, logCtx, {}, { runCore });

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  test("spawned subagent turns are exempt from the Luna attempt", async () => {
    const logCtx = { requestedModel: "test-provider/test-model", attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const runCore = async (_req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      calls += 1;
      seedAttempt(ctx, "provider", "test-provider/test-model");
      return retryable();
    };
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn" },
      body: JSON.stringify({ model: "test-provider/test-model", input: "hello", stream: false }),
    });

    const response = await handleResponsesWithPolicyFallback(req, {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  test("route and auth errors (404/401) never cross to Luna", async () => {
    for (const failure of [
      formatErrorResponse(404, "invalid_request_error", "Unknown model: nope/missing."),
      formatErrorResponse(401, "invalid_api_key", "Invalid API key."),
    ]) {
      const logCtx = { requestedModel: "test-provider/test-model", attempts: [] } as unknown as RequestLogContext;
      let calls = 0;
      const runCore = async (_req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
        calls += 1;
        seedAttempt(ctx, "provider", "test-provider/test-model");
        return failure.clone();
      };

      const response = await handleResponsesWithPolicyFallback(request("test-provider/test-model"), {} as OcxConfig, logCtx, {}, { runCore });

      expect(response.status).toBe(failure.status);
      expect(calls).toBe(1);
    }
  });

  test("helpers identify Luna targets and preserve body fields", () => {
    expect(isLunaRetryFallbackModel("openai/gpt-5.6-luna")).toBe(true);
    expect(isLunaRetryFallbackModel("gpt-5.6-luna")).toBe(true);
    expect(isLunaRetryFallbackModel("openai/gpt-5.6-sol")).toBe(false);
    expect(isLunaRetryFallbackTarget({ provider: "openai", model: "gpt-5.6-luna" })).toBe(true);
    expect(isLunaRetryFallbackTarget({ provider: "cursor", model: "gpt-5.6-luna" })).toBe(false);
    expect(isAlreadyLunaXhighAttempt({ model: LUNA_RETRY_FALLBACK_MODEL_ID, reasoning: { effort: "xhigh" } })).toBe(true);
    expect(isAlreadyLunaXhighAttempt({ model: LUNA_RETRY_FALLBACK_MODEL_ID, reasoning: { effort: "low" } })).toBe(false);
    expect(isAlreadyLunaXhighAttempt({ model: "other/model" })).toBe(false);
    const rewritten = lunaRetryFallbackBody({ model: "other/model", input: "hi", reasoning: { effort: "low" } });
    expect(rewritten).toEqual({ model: LUNA_RETRY_FALLBACK_MODEL_ID, input: "hi", reasoning: { effort: "xhigh" } });
  });

  test("explicit Luna combo target overrides inherited effort with xhigh", () => {
    const body: Record<string, unknown> = { reasoning: { effort: "high", summary: "detailed" } };
    applyLunaRetryFallbackEffort(body, { provider: "openai", model: "gpt-5.6-luna" });
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "detailed" });

    const other: Record<string, unknown> = { reasoning: { effort: "high" } };
    applyLunaRetryFallbackEffort(other, { provider: "openai", model: "gpt-5.6-sol" });
    expect(other.reasoning).toEqual({ effort: "high" });
  });

  test("Luna retry drops foreign reasoning items and signature blobs but keeps conversation content", () => {
    const input = [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "thinking", thinking: "hmm", signature: "QUJD" },
      { type: "reasoning", id: "rs_foreign", encrypted_content: "provider-private" },
      { type: "function_call", name: "f", arguments: "{}", thoughtSignature: "REVG" },
    ];
    expect(sanitizeInputForCrossProviderReplay(input)).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", name: "f", arguments: "{}" },
    ]);
    const rewritten = lunaRetryFallbackBody({ model: "other/model", input, reasoning: { effort: "low" } });
    expect(rewritten.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", name: "f", arguments: "{}" },
    ]);
    expect(sanitizeInputForCrossProviderReplay("plain string")).toBe("plain string");
  });
});
