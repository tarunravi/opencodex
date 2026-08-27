import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  apiBaseForPlane,
  discoverApiTargets,
  relayUrlForPath,
  standaloneApiTargets,
  targetsFromMachineStatus,
  type MachineStatusV1,
} from "../src/api-targets";

let win: Window;
let previousWindow: unknown;
let previousFetch: typeof fetch;

const status = (transport: "direct" | "relay"): MachineStatusV1 => ({
  mode: "client",
  connected: true,
  machineBase: "http://localhost",
  sharedBase: transport === "direct" ? "https://hub.example.test" : "http://localhost/api/machine/hub-relay",
  sharedServerOrigin: "https://hub.example.test",
  managementTransport: transport,
  apiKeyId: "client-key-a",
  protocolVersion: 1,
  connectedAt: "2026-08-28T00:00:00.000Z",
  hubReachability: "unknown",
});

beforeEach(() => {
  previousWindow = Reflect.get(globalThis, "window");
  previousFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  win.close();
});

describe("two-plane API targets", () => {
  test("404 selects the unchanged standalone same-origin target", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const targets = await discoverApiTargets("");
    expect(targets).toEqual(standaloneApiTargets(""));
    expect(apiBaseForPlane("machine", targets)).toBe("");
    expect(apiBaseForPlane("shared", targets)).toBe("");
  });

  test("constructs exact direct and fixed relay shared bases", () => {
    const direct = targetsFromMachineStatus("", status("direct"));
    expect(direct.shared).toMatchObject({ baseUrl: "https://hub.example.test", serverOrigin: "https://hub.example.test", transport: "direct" });
    const relay = targetsFromMachineStatus("", status("relay"));
    expect(relay.machine.baseUrl).toBe("");
    expect(relay.shared).toMatchObject({ baseUrl: "/api/machine/hub-relay", serverOrigin: "https://hub.example.test", transport: "relay" });
    expect(relayUrlForPath(relay.shared, "/api/usage?range=all")).toBe("/api/machine/hub-relay/api/usage?range=all");
    expect(() => relayUrlForPath(relay.shared, "/api/%2e%2e/config")).toThrow();
    expect(() => relayUrlForPath(relay.shared, "//evil.example/api/config")).toThrow();
  });

  test("a machine-status network failure is not treated as standalone", async () => {
    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await expect(discoverApiTargets("")).rejects.toThrow("local machine plane unavailable");
  });
});
