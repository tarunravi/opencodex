import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { extractAccountId, extractEmail, decodeJwtPayload } from "../oauth/chatgpt";
import { refreshGrantFingerprintForToken } from "./account-store";
import type { CodexAccountCredentials } from "../types";

const CODEXBAR_METADATA_FILE = "managed-codex-accounts.json";
const CODEXBAR_MANAGED_HOMES_DIR = "managed-codex-homes";
const MAX_CODEXBAR_METADATA_BYTES = 1024 * 1024;
const MAX_CODEXBAR_AUTH_BYTES = 128 * 1024;
const MAX_CODEXBAR_ACCOUNTS = 64;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

const TEST_ROOT_SLOT = Symbol.for("opencodex.codexbar-account-import.test-root");

interface CodexBarMetadataRow {
  id: string;
  email: string;
  managedHomePath: string;
  providerAccountID: string;
  authFingerprint: string;
  updatedAt: number;
  workspaceLabel?: string;
}

interface CodexBarMetadataFile {
  version: number;
  accounts: CodexBarMetadataRow[];
}

export interface CodexBarManagedAccount {
  /** Privacy-safe stable selector for an explicit import request. */
  sourceId: string;
  /** Deterministic non-PII OpenCodex pool id. */
  accountId: string;
  /** Kept internal; management projections must mask it before serialization. */
  email: string;
  providerAccountId: string;
  sourceFingerprint: string;
  refreshGrantFingerprint: string;
  credential: CodexAccountCredentials;
  updatedAt: number;
  /** Local CodexBar workspace title; never an email or provider id. */
  workspaceLabel?: string;
}

export interface CodexBarDiscoveryResult {
  accounts: CodexBarManagedAccount[];
  duplicateCount: number;
  invalidCount: number;
}

function defaultCodexBarRoot(): string {
  return join(homedir(), "Library", "Application Support", "CodexBar");
}

function codexBarRoot(): string {
  const testRoot = (globalThis as typeof globalThis & { [TEST_ROOT_SLOT]?: string })[TEST_ROOT_SLOT];
  return testRoot ?? defaultCodexBarRoot();
}

/** Test-only path seam. Production discovery never accepts a caller-supplied path. */
export function setCodexBarAccountImportRootForTests(path: string | null): void {
  const state = globalThis as typeof globalThis & { [TEST_ROOT_SLOT]?: string };
  if (path === null) delete state[TEST_ROOT_SLOT];
  else state[TEST_ROOT_SLOT] = path;
}

function readPrivateRegularFile(path: string, maxBytes: number): Buffer | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) return null;
    // These files carry refresh tokens. Refuse a source readable by group/other on Unix.
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return null;
    const bytes = readFileSync(path);
    return bytes.length > 0 && bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

function parseMetadata(bytes: Buffer): CodexBarMetadataFile | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) return null;
    if (!Array.isArray(value.accounts) || value.accounts.length > MAX_CODEXBAR_ACCOUNTS) return null;
    const accounts: CodexBarMetadataRow[] = [];
    for (const raw of value.accounts) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      if (
        typeof row.id !== "string" || !row.id.trim()
        || typeof row.email !== "string" || !row.email.trim()
        || typeof row.managedHomePath !== "string" || !row.managedHomePath.trim()
        || typeof row.providerAccountID !== "string" || !row.providerAccountID.trim()
        || typeof row.authFingerprint !== "string" || !SHA256_HEX_RE.test(row.authFingerprint)
        || typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)
      ) return null;
      const workspaceLabel = typeof row.workspaceLabel === "string" ? row.workspaceLabel.trim() : "";
      accounts.push({
        id: row.id,
        email: row.email,
        managedHomePath: row.managedHomePath,
        providerAccountID: row.providerAccountID,
        authFingerprint: row.authFingerprint.toLowerCase(),
        updatedAt: row.updatedAt,
        ...(workspaceLabel
          && workspaceLabel.length <= 80
          && !/[\x00-\x1f\x7f]/.test(workspaceLabel)
          ? { workspaceLabel }
          : {}),
      });
    }
    return { version: value.version, accounts };
  } catch {
    return null;
  }
}

function containedManagedHome(base: string, candidate: string): string | null {
  try {
    if (!isAbsolute(candidate)) return null;
    const canonicalBase = realpathSync(base);
    const canonicalCandidate = realpathSync(candidate);
    const rel = relative(canonicalBase, canonicalCandidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }
    return canonicalCandidate;
  } catch {
    return null;
  }
}

function jwtExpiresAt(accessToken: string, idToken: string): number {
  for (const token of [accessToken, idToken]) {
    const exp = decodeJwtPayload(token)?.exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
      const expiresAt = exp * 1000;
      if (Number.isFinite(expiresAt)) return expiresAt;
    }
  }
  // Unknown expiry forces the existing refresh path before this credential can serve traffic.
  return 0;
}

function parseManagedAccount(row: CodexBarMetadataRow, managedHomesRoot: string): CodexBarManagedAccount | null {
  const managedHome = containedManagedHome(managedHomesRoot, row.managedHomePath);
  if (!managedHome) return null;
  const bytes = readPrivateRegularFile(join(managedHome, "auth.json"), MAX_CODEXBAR_AUTH_BYTES);
  if (!bytes) return null;
  const sourceFingerprint = createHash("sha256").update(bytes).digest("hex");
  if (sourceFingerprint !== row.authFingerprint) return null;

  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      tokens?: {
        access_token?: unknown;
        refresh_token?: unknown;
        id_token?: unknown;
        account_id?: unknown;
      };
    };
    const accessToken = parsed.tokens?.access_token;
    const refreshToken = parsed.tokens?.refresh_token;
    const idToken = parsed.tokens?.id_token;
    const accountId = parsed.tokens?.account_id;
    if (
      typeof accessToken !== "string" || !accessToken
      || typeof refreshToken !== "string" || !refreshToken
      || typeof idToken !== "string" || !idToken
      || typeof accountId !== "string" || !accountId
    ) return null;

    const providerAccountId = extractAccountId(idToken, accessToken);
    const email = extractEmail(idToken, accessToken);
    if (
      !providerAccountId
      || providerAccountId !== accountId
      || providerAccountId !== row.providerAccountID
      || !email
      || email !== row.email.trim().toLowerCase()
    ) return null;

    const identityDigest = createHash("sha256")
      .update(`opencodex-codexbar-account:${providerAccountId}`)
      .digest("hex");
    return {
      sourceId: createHash("sha256").update(`opencodex-codexbar-source:${sourceFingerprint}`).digest("hex").slice(0, 24),
      accountId: `codexbar-${identityDigest.slice(0, 24)}`,
      email,
      providerAccountId,
      sourceFingerprint,
      refreshGrantFingerprint: refreshGrantFingerprintForToken(refreshToken),
      credential: {
        accessToken,
        refreshToken,
        expiresAt: jwtExpiresAt(accessToken, idToken),
        chatgptAccountId: providerAccountId,
      },
      updatedAt: row.updatedAt,
      ...(row.workspaceLabel ? { workspaceLabel: row.workspaceLabel } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Discover CodexBar-managed Codex profiles without mutating either application.
 * Raw paths, provider ids, fingerprints, emails, and tokens remain internal.
 */
export function discoverCodexBarManagedAccounts(): CodexBarDiscoveryResult {
  if (process.platform !== "darwin" && !(globalThis as typeof globalThis & { [TEST_ROOT_SLOT]?: string })[TEST_ROOT_SLOT]) {
    return { accounts: [], duplicateCount: 0, invalidCount: 0 };
  }
  const root = codexBarRoot();
  const metadataBytes = readPrivateRegularFile(join(root, CODEXBAR_METADATA_FILE), MAX_CODEXBAR_METADATA_BYTES);
  if (!metadataBytes) return { accounts: [], duplicateCount: 0, invalidCount: 0 };
  const metadata = parseMetadata(metadataBytes);
  if (!metadata) return { accounts: [], duplicateCount: 0, invalidCount: 1 };

  const managedHomesRoot = join(root, CODEXBAR_MANAGED_HOMES_DIR);
  const parsed = metadata.accounts.map(row => parseManagedAccount(row, managedHomesRoot));
  const invalidCount = parsed.filter(account => account === null).length;
  const valid = parsed.filter((account): account is CodexBarManagedAccount => account !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sourceId.localeCompare(b.sourceId));

  const providerIds = new Set<string>();
  const sourceFingerprints = new Set<string>();
  const refreshFingerprints = new Set<string>();
  const accounts: CodexBarManagedAccount[] = [];
  let duplicateCount = 0;
  for (const account of valid) {
    if (
      providerIds.has(account.providerAccountId)
      || sourceFingerprints.has(account.sourceFingerprint)
      || refreshFingerprints.has(account.refreshGrantFingerprint)
    ) {
      duplicateCount += 1;
      continue;
    }
    providerIds.add(account.providerAccountId);
    sourceFingerprints.add(account.sourceFingerprint);
    refreshFingerprints.add(account.refreshGrantFingerprint);
    accounts.push(account);
  }
  return { accounts, duplicateCount, invalidCount };
}
