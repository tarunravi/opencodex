import { spawn } from "node:child_process";
import type { Server } from "bun";
import { loadConfig } from "../config";
import { removePid, removeRuntimePort, writePid, writeRuntimePort } from "../config/process-state";
import { installCrashGuards } from "../lib/crash-guard";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { findAvailablePort } from "../server/ports";
import { startMachineListener } from "./machine-listener";
import { readClientConnectionState } from "./state";

let activeServer: Server<unknown> | null = null;
let activePort: number | null = null;
let recycleScheduled = false;

function cleanup(): void {
  removePid(process.pid);
  removeRuntimePort(process.pid);
}

export function scheduleStandaloneRecycle(): void {
  if (recycleScheduled) return;
  recycleScheduled = true;
  setTimeout(() => {
    const port = activePort;
    try { activeServer?.stop(true); } catch { /* best effort */ }
    cleanup();
    if (process.env.OCX_SERVICE !== "1" && port) {
      const child = spawn(process.execPath, selfLaunchArgv(["start", "--port", String(port)]), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env },
      });
      child.unref();
    }
    process.exit(0);
  }, 50).unref();
}

export async function startClientRuntime(
  options: { port?: number; block?: boolean } = {},
): Promise<void> {
  const state = readClientConnectionState();
  if (state.kind !== "connected") throw new Error(`client runtime refused: client state is ${state.kind}`);
  const config = loadConfig();
  const preferred = options.port ?? config.port ?? 10100;
  const port = preferred === 0
    ? 0
    : await findAvailablePort(preferred, "127.0.0.1", {
      preferRetryMs: options.port === undefined ? 750 : 5_000,
      preferRetryIntervalMs: 50,
      allowEphemeralFallback: options.port === undefined,
    });
  const server = startMachineListener(port, { state: state.value });
  activeServer = server;
  activePort = server.port;
  installCrashGuards();
  writePid(process.pid);
  writeRuntimePort({ pid: process.pid, port: server.port, hostname: "127.0.0.1" });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server.stop(true); } finally {
      cleanup();
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") process.on("SIGHUP", shutdown);
  process.on("exit", cleanup);

  if (options.block ?? true) await new Promise<void>(() => {});
}
