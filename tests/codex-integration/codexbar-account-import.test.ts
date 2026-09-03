import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverCodexBarManagedAccounts,
  setCodexBarAccountImportRootForTests,
} from "../../src/codex/codexbar-account-import";
import { getCodexAccountCredential } from "../../src/codex/account-store";
import { handleCodexAuthAPI } from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, resolveCodexAccountForThread } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import type { OcxConfig } from "../../src/types";

const TEST_ROOT = join(import.meta.dir, ".tmp-codexbar-account-import-test");
const CODEXBAR_ROOT = join(TEST_ROOT, "CodexBar");
const MANAGED_HOMES = join(CODEXBAR_ROOT, "managed-codex-homes");
const OPENCODEX_HOME = join(TEST_ROOT, "opencodex");
const CODEX_HOME = join(TEST_ROOT, "codex");

let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;

interface FixtureProfile {
  metadata: Record<string, unknown>;
  providerAccountId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  authFingerprint: string;
}

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function writeProfile(index: number, providerAccountId: string, email: string): FixtureProfile {
  const home = join(MANAGED_HOMES, `profile-${index}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const payload = {
    chatgpt_account_id: providerAccountId,
    email,
    exp: Math.floor((Date.now() + 60 * 60_000) / 1000),
  };
  const accessToken = jwt(payload);
  const idToken = jwt({ ...payload, token: "id" });
  const refreshToken = `refresh-secret-${index}`;
  const authText = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: providerAccountId,
    },
  });
  const authPath = join(home, "auth.json");
  writeFileSync(authPath, authText, { mode: 0o600 });
  const authFingerprint = createHash("sha256").update(authText).digest("hex");
  return {
    providerAccountId,
    email,
    accessToken,
    refreshToken,
    authFingerprint,
    metadata: {
      id: `source-${index}`,
      email,
      managedHomePath: home,
      providerAccountID: providerAccountId,
      workspaceAccountID: providerAccountId,
      workspaceLabel: `Account ${index}`,
      authFingerprint,
      createdAt: 100 + index,
      updatedAt: 200 + index,
      lastAuthenticatedAt: 200 + index,
    },
  };
}

function writeMetadata(rows: Record<string, unknown>[]): void {
  mkdirSync(CODEXBAR_ROOT, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(CODEXBAR_ROOT, "managed-codex-accounts.json"),
    JSON.stringify({ version: 3, accounts: rows }),
    { mode: 0o600 },
  );
}

function makeConfig(): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    codexAccountPickerEnabled: true,
    codexAccountNamespaces: {},
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 80,
  };
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(MANAGED_HOMES, { recursive: true, mode: 0o700 });
  mkdirSync(OPENCODEX_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  process.env.OPENCODEX_HOME = OPENCODEX_HOME;
  process.env.CODEX_HOME = CODEX_HOME;
  setCodexBarAccountImportRootForTests(CODEXBAR_ROOT);
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
});

afterEach(() => {
  setCodexBarAccountImportRootForTests(null);
  globalThis.fetch = previousFetch;
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe("CodexBar-managed Codex account discovery", () => {
  test("verifies bounded auth files and deduplicates provider identity and source fingerprint", () => {
    const first = writeProfile(1, "provider-alpha", "alpha@example.test");
    const second = writeProfile(2, "provider-beta", "beta@example.test");
    writeMetadata([
      first.metadata,
      { ...first.metadata, id: "duplicate-source", updatedAt: 1 },
      second.metadata,
      { ...second.metadata, id: "bad-fingerprint", authFingerprint: "0".repeat(64), updatedAt: 999 },
    ]);

    const discovered = discoverCodexBarManagedAccounts();

    expect(discovered.accounts).toHaveLength(2);
    expect(discovered.duplicateCount).toBe(1);
    expect(discovered.invalidCount).toBe(1);
    expect(new Set(discovered.accounts.map(account => account.workspaceLabel))).toEqual(new Set(["Account 1", "Account 2"]));
    expect(new Set(discovered.accounts.map(account => account.providerAccountId)).size).toBe(2);
    expect(new Set(discovered.accounts.map(account => account.sourceId)).size).toBe(2);
  });

  test("refuses a managed-home path outside CodexBar's owned profile root", () => {
    const outside = writeProfile(1, "provider-outside", "outside@example.test");
    const outsideHome = join(TEST_ROOT, "outside-profile");
    mkdirSync(outsideHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(outsideHome, "auth.json"), JSON.stringify({ tokens: {} }), { mode: 0o600 });
    writeMetadata([{ ...outside.metadata, managedHomePath: outsideHome }]);

    const discovered = discoverCodexBarManagedAccounts();

    expect(discovered.accounts).toEqual([]);
    expect(discovered.invalidCount).toBe(1);
  });
});

describe("CodexBar account management API", () => {
  test("import rejects oversized JSON before discovery or mutation", async () => {
    const profile = writeProfile(1, "provider-alpha", "alpha@example.test");
    writeMetadata([profile.metadata]);
    const config = makeConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts/import-codexbar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceIds: ["x".repeat(17 * 1024)] }),
    });

    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);

    expect(resp!.status).toBe(413);
    expect(await resp!.json()).toEqual({ error: "request body too large" });
    expect(config.codexAccounts).toEqual([]);
    expect(getCodexAccountCredential(discoverCodexBarManagedAccounts().accounts[0]!.accountId)).toBeNull();
  });

  test("discovery masks email and never serializes token, provider id, fingerprint, or path bytes", async () => {
    const profile = writeProfile(1, "provider-private", "private.user@example.test");
    writeMetadata([profile.metadata]);
    const config = makeConfig();

    const req = new Request("http://localhost/api/codex-auth/accounts/discover");
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const text = await resp!.text();
    const body = JSON.parse(text) as { accounts: Array<Record<string, unknown>> };

    expect(resp!.status).toBe(200);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.status).toBe("importable");
    for (const secret of [
      profile.email,
      profile.providerAccountId,
      profile.accessToken,
      profile.refreshToken,
      profile.authFingerprint,
      String(profile.metadata.managedHomePath),
    ]) expect(text).not.toContain(secret);
  });

  test("explicit import validates, persists, enriches, and supports immediate manual routing", async () => {
    const first = writeProfile(1, "provider-alpha", "alpha@example.test");
    const second = writeProfile(2, "provider-beta", "beta@example.test");
    writeMetadata([first.metadata, second.metadata]);
    const config = makeConfig();
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const target = String(input);
      if (target.endsWith("/backend-api/codex/responses")) {
        return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (target.endsWith("/backend-api/wham/usage")) {
        return Response.json({
          plan_type: "pro",
          rate_limit: { primary_window: { used_percent: 12, reset_at: 1_900_000_000 } },
        });
      }
      throw new Error("unexpected test fetch");
    }) as typeof fetch;

    const importReq = new Request("http://localhost/api/codex-auth/accounts/import-codexbar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const importResp = await handleCodexAuthAPI(importReq, new URL(importReq.url), config);
    const result = await importResp!.json() as {
      importedCount: number;
      failedCount: number;
      accounts: Array<{ accountId: string; status: string }>;
    };

    expect(importResp!.status).toBe(200);
    expect(result).toMatchObject({ importedCount: 2, failedCount: 0 });
    expect(config.codexAccounts).toHaveLength(2);
    expect(config.codexAccountPickerEnabled).toBe(true);
    expect(Object.values(config.codexAccountNamespaces ?? {})).toEqual(
      expect.arrayContaining([
        result.accounts[0]!.accountId,
        result.accounts[1]!.accountId,
      ]),
    );
    expect(config.codexAccounts?.map(account => account.alias).sort()).toEqual(["Account 1", "Account 2"]);
    for (const account of result.accounts) {
      expect(account.status).toBe("imported");
      expect(getCodexAccountCredential(account.accountId)?.chatgptAccountId).toBeTruthy();
      expect(config.codexAccounts?.find(row => row.id === account.accountId)?.plan).toBe("pro");
    }

    const selectedId = result.accounts[1]!.accountId;
    const selectReq = new Request("http://localhost/api/codex-auth/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: selectedId }),
    });
    const selectResp = await handleCodexAuthAPI(selectReq, new URL(selectReq.url), config);
    expect(selectResp!.status).toBe(200);
    expect(resolveCodexAccountForThread("imported-thread", config)).toBe(selectedId);

    const repeatReq = new Request("http://localhost/api/codex-auth/accounts/import-codexbar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const repeated = await handleCodexAuthAPI(repeatReq, new URL(repeatReq.url), config);
    expect(await repeated!.json()).toMatchObject({ importedCount: 0, existingCount: 2, failedCount: 0 });
  });
});
