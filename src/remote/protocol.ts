import type { OcxConfig } from "../types/config";

export const REMOTE_HUB_PROTOCOL = 1;
export const MINIMUM_REMOTE_CLIENT_PROTOCOL = 1;

export interface RemoteReadyMetadata {
  protocol: number;
  minimumClientProtocol: number;
  managementUrl: string;
}

export type RemoteProtocolCompatibility =
  | { ok: true; metadata: RemoteReadyMetadata }
  | { ok: false; reason: "invalid" | "hub-too-new" | "hub-too-old"; message: string };

const INVALID_REMOTE_PROTOCOL_MESSAGE =
  "OpenCodex hub returned invalid remote protocol metadata; upgrade or repair ocx on the hub.";

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function managementOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function readyProtocolMetadata(config: OcxConfig, req: Request): RemoteReadyMetadata {
  // Phase 2 will consult config.hub.managementPublicOrigin here. Keeping the
  // parameter now fixes the consumer signature without changing Phase 1 behavior.
  void config;
  const managementUrl = managementOrigin(new URL(req.url).origin);
  if (!managementUrl) throw new Error("Readiness request does not have an HTTP(S) management origin");
  return {
    protocol: REMOTE_HUB_PROTOCOL,
    minimumClientProtocol: MINIMUM_REMOTE_CLIENT_PROTOCOL,
    managementUrl,
  };
}

export function parseRemoteReadyMetadata(value: unknown): RemoteReadyMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!positiveSafeInteger(raw.protocol) || !positiveSafeInteger(raw.minimumClientProtocol)) return null;
  if (raw.minimumClientProtocol > raw.protocol) return null;
  const parsedManagementOrigin = managementOrigin(raw.managementUrl);
  if (!parsedManagementOrigin) return null;
  return {
    protocol: raw.protocol,
    minimumClientProtocol: raw.minimumClientProtocol,
    managementUrl: parsedManagementOrigin,
  };
}

export function checkRemoteProtocolCompatibility(
  value: unknown,
  client: { protocol: number; minimumHubProtocol: number } = {
    protocol: REMOTE_HUB_PROTOCOL,
    minimumHubProtocol: MINIMUM_REMOTE_CLIENT_PROTOCOL,
  },
): RemoteProtocolCompatibility {
  const metadata = parseRemoteReadyMetadata(value);
  if (!metadata || !positiveSafeInteger(client.protocol) || !positiveSafeInteger(client.minimumHubProtocol)) {
    return { ok: false, reason: "invalid", message: INVALID_REMOTE_PROTOCOL_MESSAGE };
  }
  if (client.protocol < metadata.minimumClientProtocol) {
    return {
      ok: false,
      reason: "hub-too-new",
      message: `OpenCodex hub requires remote protocol ${metadata.minimumClientProtocol}; this client supports protocol ${client.protocol}. Upgrade ocx on this client.`,
    };
  }
  if (metadata.protocol < client.minimumHubProtocol) {
    return {
      ok: false,
      reason: "hub-too-old",
      message: `OpenCodex hub provides remote protocol ${metadata.protocol}; this client requires at least ${client.minimumHubProtocol}. Upgrade ocx on the hub.`,
    };
  }
  return { ok: true, metadata };
}
