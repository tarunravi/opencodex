import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { rotateKeyOn429 } from "../src/providers/key-failover";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "key-first-000111222333" },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-keys-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-provider-keys-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("provider API key pool", () => {
  test("GET seeds legacy bare apiKey into a one-entry pool with masked value", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { activeId: string | null; keys: Array<{ id: string; masked: string; active: boolean }> };
      expect(body.keys.length).toBe(1);
      expect(body.keys[0]!.active).toBe(true);
      expect(body.keys[0]!.masked.includes("****")).toBe(true);
      expect(JSON.stringify(body).includes("key-first-000111222333")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("provider list exposes disabled and setup state without key material", async () => {
    const config = baseConfig();
    config.providers.disabled = { adapter: "openai-chat", baseUrl: "https://disabled.example/v1", apiKey: "disabled-secret", disabled: true };
    config.providers.optional = { adapter: "openai-chat", baseUrl: "https://optional.example/v1", keyOptional: true };
    saveConfig(config);
    const server = startServer(0);
    try {
      const raw = await fetch(new URL("/api/providers", server.url)).then(r => r.text());
      const rows = JSON.parse(raw) as Array<{ name: string; disabled?: boolean; keyOptional?: boolean }>;
      expect(rows.find(row => row.name === "disabled")).toMatchObject({ disabled: true, keyOptional: false });
      expect(rows.find(row => row.name === "optional")).toMatchObject({ disabled: false, keyOptional: true });
      expect(raw).not.toContain("disabled-secret");
    } finally {
      await server.stop(true);
    }
  });

  test("POST adds + activates; PUT switches; DELETE removes and promotes", async () => {
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "key-second-444555666777" }),
      });
      expect(add.status).toBe(201);
      const { id: secondId } = await add.json() as { id: string };

      let list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { activeId: string; keys: Array<{ id: string; active: boolean }> };
      expect(list.keys.length).toBe(2);
      expect(list.activeId).toBe(secondId); // new key becomes active

      // config.json mirrors the active key into apiKey
      const cfg = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg.providers["opencode-go"].apiKey).toBe("key-second-444555666777");

      const firstId = list.keys.find(k => k.id !== secondId)!.id;
      const rename = await fetch(new URL("/api/providers/keys/alias", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: secondId, alias: "Work key" }),
      });
      expect(rename.status).toBe(200);
      const renamed = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { keys: Array<{ id: string; label?: string }> };
      expect(renamed.keys.find(key => key.id === secondId)?.label).toBe("Work key");
      const put = await fetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: firstId }),
      });
      expect(put.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.activeId).toBe(firstId);

      // Remove the active key: the other one is promoted.
      const del = await fetch(new URL(`/api/providers/keys?name=opencode-go&id=${firstId}`, server.url), { method: "DELETE" });
      expect(del.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.keys.length).toBe(1);
      expect(list.activeId).toBe(secondId);
      const cfg2 = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg2.providers["opencode-go"].apiKey).toBe("key-second-444555666777");
    } finally {
      await server.stop(true);
    }
  });

  test("GET exposes active key cooldowns without exposing key material", async () => {
    const config = baseConfig();
    config.providers["opencode-go"]!.apiKeyPool = [
      { id: "first", key: "key-first-000111222333" },
      { id: "second", key: "key-second-444555666777" },
    ];
    saveConfig(config);
    const before = Date.now();
    rotateKeyOn429(config, "opencode-go", "60", before, "key-first-000111222333");
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url));
      const raw = await response.text();
      const body = JSON.parse(raw) as { keys: Array<{ id: string; cooldownUntil?: number }> };
      expect(body.keys.find(key => key.id === "first")?.cooldownUntil).toBe(before + 60_000);
      expect(body.keys.find(key => key.id === "second")?.cooldownUntil).toBeUndefined();
      expect(raw).not.toContain("key-first-000111222333");
      expect(raw).not.toContain("key-second-444555666777");

      const providersRaw = await fetch(new URL("/api/providers", server.url)).then(r => r.text());
      const providers = JSON.parse(providersRaw) as Array<{ name: string; coolingKeyCount?: number; nextKeyRecoveryAt?: number }>;
      expect(providers.find(provider => provider.name === "opencode-go")).toMatchObject({
        coolingKeyCount: 1,
        nextKeyRecoveryAt: before + 60_000,
      });
      expect(providersRaw).not.toContain("key-first-000111222333");
      expect(providersRaw).not.toContain("key-second-444555666777");
    } finally {
      await server.stop(true);
    }
  });

  test("unknown provider 404; empty key 400", async () => {
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/providers/keys?name=nope", server.url));
      expect(missing.status).toBe(404);
      const bad = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "   " }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});
