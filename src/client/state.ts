import { readFileSync } from "node:fs";
import {
  getConfigPath,
  mutatePersistedConfig,
  readConfigDiagnostics,
} from "../config";
import type { OcxClientConnectionConfig } from "../types";

export type ClientConnectionState =
  | { kind: "disconnected" }
  | { kind: "connected"; value: OcxClientConnectionConfig }
  | { kind: "invalid"; reason: string }
  | { kind: "mismatched"; reason: string };

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
  if (!hasClient && role === "hub") {
    return { kind: "mismatched", reason: "runtimeRole=hub cannot be used as a connected client" };
  }
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
    delete config.client;
    delete config.runtimeRole;
    return { changed: true, value: "committed" as const };
  });
  if (outcome.status === "unavailable") return "conflict";
  return outcome.value;
}
