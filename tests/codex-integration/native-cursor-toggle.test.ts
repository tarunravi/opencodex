import { describe, expect, test } from "bun:test";
import { CursorMcpConfigError, type CursorMcpConfigState } from "../../src/integrations/cursor-config";
import { handleNativeIntegrationRoutes } from "../../src/server/management/native-integration-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const config = { port: 10100, hostname: "127.0.0.1", providers: [] } as unknown as OcxConfig;

function cursorState(overrides: Partial<CursorMcpConfigState> = {}): CursorMcpConfigState {
  return {
    configPath: "/fixture/.cursor/mcp.json",
    enabled: false,
    installed: true,
    kind: "absent",
    ...overrides,
  };
}

async function dispatch(method: string, body: unknown, deps: ManagementContext["deps"]): Promise<Response> {
  const url = new URL(`http://127.0.0.1:10100/api/native-integrations/${method === "GET" ? "cursor-mcp" : "cursor"}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const response = await handleNativeIntegrationRoutes({
    req,
    url,
    config,
    deps,
    convergeCodexCatalog: async () => ({ status: "converged" }) as never,
    syncClaudeAgentDefsBestEffort: async () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}

describe("native Cursor MCP toggle", () => {
  test("leaves the upstream Cursor status route to its owning handler", async () => {
    const url = new URL("http://127.0.0.1:10100/api/native-integrations/cursor");
    expect(await handleNativeIntegrationRoutes({ req: new Request(url), url, config, deps: {} } as ManagementContext)).toBeNull();
  });
  test("GET reports the owned entry as current without a second desired-state flag", async () => {
    const response = await dispatch("GET", undefined, {
      readCursorMcpState: () => cursorState({ enabled: true, kind: "current" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      clientId: "cursor",
      state: "current",
      desiredEnabled: true,
      disableBlocked: null,
    });
  });

  test("enable writes the runtime port and states the native-traffic limitation", async () => {
    let seenPort: number | undefined;
    const response = await dispatch("PUT", { enabled: true }, {
      readRuntimePort: () => ({ pid: process.pid, port: 20202, hostname: "127.0.0.1" }),
      readCursorMcpState: () => cursorState(),
      enableCursorMcp: port => {
        seenPort = port;
        return cursorState({ enabled: true, kind: "current", changed: true });
      },
    });
    expect(seenPort).toBe(20202);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.changed).toBe(true);
    expect(body.state).toBe("current");
    expect(String(body.message)).toContain("Cursor's own Agent/Composer inference is unchanged");
  });

  test("a user-owned server name maps the config refusal to 409", async () => {
    let disabled = false;
    const response = await dispatch("PUT", { enabled: false }, {
      readCursorMcpState: () => cursorState({ kind: "foreign", message: "user-owned entry" }),
      disableCursorMcp: () => {
        disabled = true;
        throw new CursorMcpConfigError("foreign_entry", "user-owned entry");
      },
    });
    expect(disabled).toBe(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "native_integration_refused",
      reason: "foreign_entry",
    });
  });
});
