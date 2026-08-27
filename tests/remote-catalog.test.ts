import { describe, expect, test } from "bun:test";
import { downloadClientCatalog, HubClientError } from "../src/client/hub-client";

const JSON_HEADERS = { "Content-Type": "application/json", ETag: '"catalog-v1"' };

function response(body: string, headers: HeadersInit = JSON_HEADERS): Response {
  return new Response(body, { headers });
}

describe("remote catalog adversarial consumer", () => {
  test("accepts additive fields only after the required model schema and key id pass", async () => {
    const body = JSON.stringify({ models: [{ slug: "provider/model", future: { enabled: true } }], futureTop: 1 });
    const result = await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => response(body, { ...JSON_HEADERS, "X-OpenCodex-Key-Id": "client-key-1" }),
    });
    expect(result).toEqual({ kind: "fresh", body, etag: '"catalog-v1"', keyId: "client-key-1" });
  });

  test.each([
    ["malformed JSON", "{", "catalog_invalid"],
    ["null top level", "null", "catalog_schema_invalid"],
    ["array top level", "[]", "catalog_schema_invalid"],
    ["missing models", "{}", "catalog_schema_invalid"],
    ["non-array models", '{"models":{}}', "catalog_schema_invalid"],
    ["non-object row", '{"models":[null]}', "catalog_schema_invalid"],
    ["empty slug", '{"models":[{"slug":""}]}', "catalog_schema_invalid"],
    ["control slug", '{"models":[{"slug":"bad\\u0000slug"}]}', "catalog_schema_invalid"],
    ["duplicate slug", '{"models":[{"slug":"a"},{"slug":"a"}]}', "catalog_schema_invalid"],
  ])("rejects %s without returning writable bytes", async (_label, body, code) => {
    let caught: unknown;
    try {
      await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
        fetchImpl: async () => response(body),
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HubClientError);
    expect((caught as HubClientError).code).toBe(code);
  });

  test("rejects 2,001 rows and a forged small Content-Length with oversized chunks", async () => {
    const rows = JSON.stringify({ models: Array.from({ length: 2_001 }, (_, index) => ({ slug: `p/m-${index}` })) });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => response(rows),
    })).rejects.toMatchObject({ code: "catalog_schema_invalid" });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"models":['));
        controller.enqueue(new Uint8Array(128).fill(0x61));
        controller.close();
      },
    });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      maxBytes: 32,
      fetchImpl: async () => new Response(stream, { headers: { "Content-Type": "application/json", "Content-Length": "1" } }),
    })).rejects.toMatchObject({ code: "body_too_large" });
  });

  test("allows the exact byte cap and retries one unconditional request after 304 without LKG", async () => {
    const body = '{"models":[]}';
    const exact = await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      maxBytes: new TextEncoder().encode(body).byteLength,
      fetchImpl: async () => response(body),
    });
    expect(exact.kind).toBe("fresh");

    let calls = 0;
    const refreshed = await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async (_input, init) => {
        calls += 1;
        expect(new Headers(init?.headers).has("if-none-match")).toBe(false);
        return calls === 1 ? new Response(null, { status: 304 }) : response(body);
      },
    });
    expect(calls).toBe(2);
    expect(refreshed.kind).toBe("fresh");
  });

  test("any 304 is a protocol error and non-JSON content is refused", async () => {
    // The client sends no conditional request — /v1/catalog emits no validator (Phase 1,
    // D2) — so a 304 can only come from a hub that is misconfigured or being impersonated.
    // Earlier revisions of this phase distinguished "304 with no last-known-good" from
    // "304 whose ETag disagrees with the one we sent"; neither situation is reachable now,
    // and the single refusal below is strictly wider than both.
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => new Response(null, { status: 304 }),
    })).rejects.toMatchObject({ code: "catalog_unexpected_304" });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => new Response(null, { status: 304, headers: { ETag: '"other"' } }),
    })).rejects.toMatchObject({ code: "catalog_unexpected_304" });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => new Response('{"models":[]}', { headers: { "Content-Type": "text/html" } }),
    })).rejects.toMatchObject({ code: "catalog_content_type_invalid" });
  });
});
