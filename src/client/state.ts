import { readFileSync } from "node:fs";
import {
  getConfigPath,
  deleteConfigTopLevelKey,
  getDefaultConfig,
  mutatePersistedConfig,
  readConfigDiagnostics,
  saveConfig,
} from "../config";
import type { OcxClientConnectionConfig } from "../types";
import {
  readServiceApiTokenState,
  readTokenBackupState,
  removeOrphanTokenBackup,
} from "../lib/service-secrets";

export type ClientConnectionState =
  | { kind: "disconnected" }
  | { kind: "connected"; value: OcxClientConnectionConfig }
  | { kind: "invalid"; reason: string }
  | { kind: "mismatched"; reason: string };

export type ClientRotationRecoveryGate =
  | { kind: "clean" }
  | { kind: "orphan-cleaned" }
  | { kind: "recovery-required"; reason: string }
  | { kind: "unsafe"; reason: string };

function rawTopLevelConfig(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(getConfigPath(), "utf8").replace(/^\uFEFF/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function readClientConnectionState(): ClientConnectionState {
  const raw = rawTopLevelConfig();
  const diagnostics = readConfigDiagnostics();
  if (!raw) {
    return diagnostics.source === "default"
      ? { kind: "disconnected" }
      : { kind: "invalid", reason: "config.json is missing or unreadable" };
  }
  const hasClient = Object.hasOwn(raw, "client") && raw.client !== undefined;
  const role = raw.runtimeRole;
  if (role !== undefined && role !== "standalone" && role !== "hub" && role !== "client") {
    return { kind: "invalid", reason: "config.json.runtimeRole is invalid" };
  }
  if (!hasClient && (role === undefined || role === "standalone")) return { kind: "disconnected" };
  // A hub is a server role, not a broken client: without client state it simply is not
  // connected, and refusing here blocked `ocx start` on every hub (found on the first
  // clisu-oracle dogfood boot). Hub role WITH client state remains mismatched below.
  if (!hasClient && role === "hub") return { kind: "disconnected" };
  if (!hasClient || role !== "client") {
    return {
      kind: "mismatched",
      reason: hasClient
        ? "config.json.client is present without runtimeRole=client"
        : "runtimeRole=client is present without config.json.client",
    };
  }
  const client = diagnostics.config.client;
  if (!client) {
    const warning = diagnostics.warnings?.find(value => value.startsWith("client"));
    return { kind: "invalid", reason: warning ?? "config.json.client is malformed" };
  }
  return { kind: "connected", value: client };
}

export function inspectClientRotationRecoveryGate(
  state: ClientConnectionState = readClientConnectionState(),
): ClientRotationRecoveryGate {
  const current = readServiceApiTokenState();
  const backup = readTokenBackupState();
  if (state.kind === "connected" && state.value.pendingOperation) {
    if (current.kind !== "present" || backup.kind !== "present") {
      return {
        kind: "unsafe",
        reason: "pending key rotation requires owner-only service-api-token and service-api-token.prev files",
      };
    }
    return {
      kind: "recovery-required",
      reason: "rerun ocx connect rotate with --pairing-code-stdin or --admin-token-stdin",
    };
  }
  if (backup.kind === "unsafe") return { kind: "unsafe", reason: backup.reason };
  if (backup.kind === "present" && current.kind === "present") {
    try {
      removeOrphanTokenBackup();
      return { kind: "orphan-cleaned" };
    } catch (error) {
      return { kind: "unsafe", reason: error instanceof Error ? error.message : "token backup cleanup failed" };
    }
  }
  return { kind: "clean" };
}

export function commitClientConnection(
  state: OcxClientConnectionConfig,
): "committed" | "unchanged" {
  const outcome = mutatePersistedConfig(config => {
    const unchanged = config.runtimeRole === "client"
      && JSON.stringify(config.client) === JSON.stringify(state);
    if (!unchanged) {
      config.runtimeRole = "client";
      config.client = structuredClone(state);
    }
    return { changed: !unchanged, value: undefined };
  });
  if (outcome.status === "committed" || outcome.status === "unchanged") return outcome.status;
  if (outcome.status === "unavailable" && outcome.reason === "missing") {
    // First ocx run on a fresh machine: ocx connect is the expected first command in
    // client mode, so there is no config.json yet. mutatePersistedConfig correctly
    // refuses to invent one (a lost config must fail closed), but a genuinely absent
    // file is the bootstrap case, not corruption — seed defaults plus the client
    // block atomically. Found on the first MacBook↔oracle dogfood connect.
    const seeded = getDefaultConfig();
    seeded.runtimeRole = "client";
    seeded.client = structuredClone(state);
    saveConfig(seeded);
    return "committed";
  }
  throw new Error(`client state commit unavailable: ${"reason" in outcome ? outcome.reason : "unknown"}`);
}

export function clearClientConnection(
  expectedApiKeyId: string,
): "committed" | "absent" | "conflict" {
  const outcome = mutatePersistedConfig(config => {
    if (!config.client && config.runtimeRole !== "client") {
      return { changed: false, value: "absent" as const };
    }
    if (!config.client || config.runtimeRole !== "client" || config.client.apiKeyId !== expectedApiKeyId) {
      return { changed: false, value: "conflict" as const };
    }
    deleteConfigTopLevelKey(config, "client");
    deleteConfigTopLevelKey(config, "runtimeRole");
    return { changed: true, value: "committed" as const };
  });
  if (outcome.status === "unavailable") return "conflict";
  return outcome.value;
}
