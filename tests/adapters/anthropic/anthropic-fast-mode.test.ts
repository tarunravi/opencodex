import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import type { FastWire, OcxParsedRequest, OcxProviderConfig, TierDecision, TierObservationContext } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const FAST_WIRE: FastWire = {
  kind: "anthropic-speed",
  canonicalToWire: { priority: "fast" },
  foreignCallerTiers: "drop",
  betas: ["test-fast-beta"],
};
const FAST_OBSERVATION: TierObservationContext = {
  capability: true,
  eligibility: "eligible",
  fastWire: FAST_WIRE,
  demandDecision: "force-fast",
};
const DEFAULT_OBSERVATION: TierObservationContext = { ...FAST_OBSERVATION, demandDecision: "force-default" };

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "test-key", ...overrides };
}

function parsed(tierDecision?: TierDecision): OcxParsedRequest {
  return {
    modelId: "claude-opus-4-8",
    stream: false,
    context: { messages: [{ role: "user", content: "hello" }] },
    options: tierDecision
      ? { tierDecision, tierObservation: tierDecision.kind === "set" ? FAST_OBSERVATION : DEFAULT_OBSERVATION }
      : {},
  } as OcxParsedRequest;
}

async function build(providerConfig: OcxProviderConfig, request: OcxParsedRequest) {
  const adapter = createAnthropicAdapter(providerConfig);
  return adapter.buildRequest(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() });
}

describe("Anthropic Fast Mode", () => {
  test("serializes speed and merges OAuth/provider betas", async () => {
    const request = await build(provider({
      authMode: "oauth",
      headers: { "anthropic-beta": "provider-beta" },
    }), parsed({ kind: "set", value: "fast" }));
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const betas = request.headers["anthropic-beta"].split(",");

    expect(body.speed).toBe("fast");
    expect(betas).toEqual(expect.arrayContaining(["claude-code-20250219", "oauth-2025-04-20", "provider-beta", "test-fast-beta"]));
    expect(request.tierLog?.outcome).toMatchObject({ wireKind: "anthropic-speed", wireValue: "fast" });
  });

  test("default requests omit speed and the Fast beta", async () => {
    const request = await build(provider({ headers: { "anthropic-beta": "provider-beta" } }), parsed({ kind: "drop" }));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.speed).toBeUndefined();
    expect(request.headers["anthropic-beta"]).toBe("provider-beta");
    expect(request.tierLog?.outcome).toMatchObject({ wireKind: null, wireValue: null, fastOutcome: "not-requested" });
  });

  test("confirms JSON usage.speed and downgrades on an SSE default response", async () => {
    const adapter = createAnthropicAdapter(provider());
    const request = await adapter.buildRequest(parsed({ kind: "set", value: "fast" }), {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    await adapter.parseResponse!(new Response(JSON.stringify({ content: [], usage: { speed: "fast" } })), createTestTranslatorBudget(), request.tierLog);
    expect(request.tierLog?.outcome).toMatchObject({ responseServiceTier: "fast", confirmation: "confirmed" });

    const sse = new Response([
      "event: message_start\n",
      'data: {"type":"message_start","message":{"usage":{"speed":"default"}}}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const sseRequest = await adapter.buildRequest(parsed({ kind: "set", value: "fast" }), {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    for await (const _event of adapter.parseStream(sse, createTestTranslatorBudget(), sseRequest.tierLog)) {}
    expect(sseRequest.tierLog?.outcome).toMatchObject({ responseServiceTier: "default", fastOutcome: "downgraded", fastDowngradeReason: "response-declined" });
  });

  test("marks malformed JSON and SSE responses as unparseable", async () => {
    const adapter = createAnthropicAdapter(provider());
    const jsonRequest = await adapter.buildRequest(parsed({ kind: "set", value: "fast" }), {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    await expect(adapter.parseResponse!(
      new Response("{"),
      createTestTranslatorBudget(),
      jsonRequest.tierLog,
    )).rejects.toThrow();
    expect(jsonRequest.tierLog?.outcome).toMatchObject({ fastOutcome: "unknown", confirmation: "unknown" });

    const sseRequest = await adapter.buildRequest(parsed({ kind: "set", value: "fast" }), {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    const sse = new Response([
      "event: message_start\n",
      "data: {\n\n",
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    for await (const _event of adapter.parseStream(sse, createTestTranslatorBudget(), sseRequest.tierLog)) {}
    expect(sseRequest.tierLog?.outcome).toMatchObject({ fastOutcome: "unknown", confirmation: "unknown" });
  });
});
