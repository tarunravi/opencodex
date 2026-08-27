export type ApiPlane = "machine" | "shared";
export type SharedTransport = "same-origin" | "direct" | "relay";

export interface ApiTarget {
  id: ApiPlane;
  baseUrl: string;
  serverOrigin: string;
  bootstrapPath: string;
  transport: SharedTransport;
}

export interface ApiTargets {
  connected: boolean;
  machine: ApiTarget;
  shared: ApiTarget;
  apiKeyId?: string;
}

export interface MachineStatusV1 {
  mode: "client";
  connected: true;
  machineBase: string;
  sharedBase: string;
  sharedServerOrigin: string;
  managementTransport: "direct" | "relay";
  apiKeyId: string;
  protocolVersion: 1;
  connectedAt: string;
  catalogSyncedAt?: string;
  hubReachability: "unknown" | "online" | "offline" | "unauthorized";
}

function trimBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function absoluteBase(value: string): URL {
  return new URL(value || "/", window.location.href);
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function target(id: ApiPlane, baseUrl: string, serverOrigin: string, transport: SharedTransport): ApiTarget {
  const base = trimBase(baseUrl);
  return { id, baseUrl: base, serverOrigin, bootstrapPath: `${base}/opencodex-session`, transport };
}

export function standaloneApiTargets(initialBase: string): ApiTargets {
  const resolved = absoluteBase(initialBase);
  const baseUrl = trimBase(initialBase);
  return {
    connected: false,
    machine: target("machine", baseUrl, resolved.origin, "same-origin"),
    shared: target("shared", baseUrl, resolved.origin, "same-origin"),
  };
}

function validStatus(value: unknown): value is MachineStatusV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.mode === "client" && row.connected === true && row.protocolVersion === 1
    && (row.managementTransport === "direct" || row.managementTransport === "relay")
    && typeof row.machineBase === "string" && typeof row.sharedBase === "string"
    && typeof row.sharedServerOrigin === "string" && typeof row.apiKeyId === "string"
    && row.apiKeyId.trim().length > 0 && typeof row.connectedAt === "string";
}

export function relayUrlForPath(shared: ApiTarget, path: string): string {
  if (shared.transport !== "relay" || (!path.startsWith("/api/") && path !== "/opencodex-session")) {
    throw new TypeError("path is not eligible for the fixed hub relay");
  }
  if (path.startsWith("//") || path.includes("\\") || /%(?:2f|5c|2e)/i.test(path) || path.includes("#")) {
    throw new TypeError("encoded or authority relay path refused");
  }
  return `${trimBase(shared.baseUrl)}${path}`;
}

export function targetsFromMachineStatus(initialBase: string, status: MachineStatusV1): ApiTargets {
  if (!validStatus(status)) throw new TypeError("machine status response is invalid");
  const initial = standaloneApiTargets(initialBase);
  const machineOrigin = canonicalOrigin(status.machineBase);
  const sharedOrigin = canonicalOrigin(status.sharedServerOrigin);
  if (!machineOrigin || machineOrigin !== initial.machine.serverOrigin || !sharedOrigin) {
    throw new TypeError("machine status target origins are invalid");
  }
  const machine = target("machine", trimBase(initialBase), machineOrigin, "same-origin");
  const shared = status.managementTransport === "relay"
    ? target("shared", `${trimBase(initialBase)}/api/machine/hub-relay`, sharedOrigin, "relay")
    : target("shared", sharedOrigin, sharedOrigin, "direct");
  return { connected: true, machine, shared, apiKeyId: status.apiKeyId };
}

export function apiBaseForPlane(plane: ApiPlane, targets: ApiTargets): string {
  return targets[plane].baseUrl;
}

export async function discoverApiTargets(initialBase: string, signal?: AbortSignal): Promise<ApiTargets> {
  const standalone = standaloneApiTargets(initialBase);
  let response: Response;
  try {
    response = await fetch(`${standalone.machine.baseUrl}/api/machine/status`, { signal, cache: "no-store" });
  } catch (error) {
    throw new Error("local machine plane unavailable", { cause: error });
  }
  if (response.status === 404) return standalone;
  if (!response.ok) throw new Error(`local machine plane refused discovery (${response.status})`);
  const body = await response.json().catch(() => null);
  if (!validStatus(body)) throw new Error("local machine plane returned invalid status");
  return targetsFromMachineStatus(initialBase, body);
}
