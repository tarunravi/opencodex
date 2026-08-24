import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

function config(baseUrl = "https://litellm.example/openai/v1", allowPrivateNetwork = false): OcxConfig {
  return {
    defaultProvider: "litellm",
    providers: {
      litellm: {
        adapter: "openai-responses",
        authMode: "key",
        baseUrl,
        apiKey: "litellm-secret",
        headers: { "x-scale-codex": "true" },
        ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      },
    },
  } as OcxConfig;
}

beforeEach(() => clearProviderQuotaCache());

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
});

describe("LiteLLM provider quota", () => {
  test("reads per-key spend and reset time from /key/info", async () => {
    const seen: Array<{ url: string; authorization: string | null; codex: string | null; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        authorization: headers.get("authorization"),
        codex: headers.get("x-scale-codex"),
        redirect: init?.redirect,
      });
      return new Response(JSON.stringify({
        info: {
          spend: "125.25",
          max_budget: 5_000,
          budget_duration: "30d",
          budget_reset_at: "2026-09-23T18:22:00Z",
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);

    expect(seen).toEqual([{
      url: "https://litellm.example/openai/key/info",
      authorization: "Bearer litellm-secret",
      codex: "true",
      redirect: "error",
    }]);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      provider: "litellm",
      source: "litellm:key-info",
      quota: {
        customWindows: [{
          label: "LiteLLM",
          percent: 2.505,
          resetAt: Date.parse("2026-09-23T18:22:00Z"),
        }],
        creditsUsd: {
          used: 125.25,
          limit: 5_000,
          remaining: 4_874.75,
          percent: 2.505,
          expiresAt: Date.parse("2026-09-23T18:22:00Z"),
        },
      },
    });
  });

  test("supports an explicitly allowed loopback bridge", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ info: { spend: 1, max_budget: 10 } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config("http://127.0.0.1:41113/v1", true), true);

    expect(seenUrl).toBe("http://127.0.0.1:41113/key/info");
    expect(result.reports).toHaveLength(1);
  });

  test("rejects plaintext endpoints and malformed spend payloads", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ info: { spend: -1, max_budget: 0 } }), { status: 200 });
    }) as typeof fetch;

    expect((await fetchProviderQuotaReports(config("http://litellm.example/v1"), true)).reports).toEqual([]);
    expect(calls).toBe(0);
    expect((await fetchProviderQuotaReports(config("http://127.0.0.1:41113/v1"), true)).reports).toEqual([]);
    expect(calls).toBe(0);
    expect((await fetchProviderQuotaReports(config(), true)).reports).toEqual([]);
    expect(calls).toBe(1);
  });
});
