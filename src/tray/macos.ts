import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../config";

export const MACOS_MENUBAR_LABEL = "com.opencodex.menubar";
export const MACOS_MENUBAR_BUNDLE_ID = "com.opencodex.menubar";
export const MACOS_MENUBAR_APP_NAME = "OpenCodex.app";
/** Exact process names that are only our companion or leftover compile-check binaries. */
export const MACOS_MENUBAR_STRAY_PROCESS_NAMES = ["opencodex-menubar", "ocx-menubar-build-check"] as const;

const SOURCE_SWIFT = join(import.meta.dir, "macos", "menubar.swift");

export interface MacosMenubarStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  binaryExists: boolean;
  stale: boolean;
  processCount: number;
  summary: string;
}

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function plistPath(): string {
  return join(launchAgentsDir(), `${MACOS_MENUBAR_LABEL}.plist`);
}

function menubarDir(): string {
  return join(getConfigDir(), "menubar");
}

export function macosMenubarAppPath(): string {
  return join(menubarDir(), MACOS_MENUBAR_APP_NAME);
}

export function macosMenubarExecutablePath(): string {
  return join(macosMenubarAppPath(), "Contents", "MacOS", "OpenCodex");
}

function legacyBinaryPath(): string {
  return join(menubarDir(), "opencodex-menubar");
}

function stdoutLogPath(): string {
  return join(menubarDir(), "stdout.log");
}

function stderrLogPath(): string {
  return join(menubarDir(), "stderr.log");
}

function isMacos(): boolean {
  return process.platform === "darwin";
}

function assertMacos(): void {
  if (!isMacos()) throw new Error("The opencodex menubar is macOS-only.");
}

function swiftExe(): string {
  try {
    return execFileSync("which", ["swiftc"], { encoding: "utf8" }).trim();
  } catch {
    return "swiftc";
  }
}

function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>OpenCodex</string>
  <key>CFBundleIdentifier</key>
  <string>${MACOS_MENUBAR_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>OpenCodex</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;
}

function buildAppBundle(): void {
  assertMacos();
  if (!existsSync(SOURCE_SWIFT)) {
    throw new Error(`Menubar source not found: ${SOURCE_SWIFT}`);
  }
  const executable = macosMenubarExecutablePath();
  mkdirSync(join(macosMenubarAppPath(), "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(macosMenubarAppPath(), "Contents", "Resources"), { recursive: true });
  writeFileSync(join(macosMenubarAppPath(), "Contents", "Info.plist"), infoPlist(), { mode: 0o644 });
  execFileSync(swiftExe(), ["-O", "-o", executable, SOURCE_SWIFT], {
    stdio: "inherit",
    env: { ...process.env, SWIFT_DETERMINISTIC_HASHING: "1" },
  });
  try { rmSync(legacyBinaryPath()); } catch { /* leftover bare binary from the first install */ }
}

function buildPlist(): string {
  const configDir = getConfigDir();
  const binary = macosMenubarExecutablePath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_MENUBAR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(binary)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCODEX_HOME</key>
    <string>${escapeXml(configDir)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLogPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLogPath())}</string>
</dict>
</plist>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistMatchesCurrent(): boolean {
  const path = plistPath();
  if (!existsSync(path)) return false;
  try {
    const content = readFileSync(path, "utf8");
    return content.includes(`<string>${MACOS_MENUBAR_LABEL}</string>`)
      && content.includes(macosMenubarExecutablePath());
  } catch {
    return false;
  }
}

function launchctl(args: string[], options: { ignoreError?: boolean } = {}): void {
  try {
    execFileSync("launchctl", args, { stdio: options.ignoreError ? "pipe" : "inherit" });
  } catch (error) {
    if (!options.ignoreError) throw error;
  }
}

function unloadPlist(): void {
  const path = plistPath();
  if (!existsSync(path)) return;
  launchctl(["unload", path], { ignoreError: true });
  launchctl(["bootout", `gui/${process.getuid?.() ?? 501}`, path], { ignoreError: true });
}

function loadPlist(): void {
  mkdirSync(launchAgentsDir(), { recursive: true });
  const path = plistPath();
  writeFileSync(path, buildPlist(), { mode: 0o644 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  launchctl(["bootstrap", domain, path], { ignoreError: true });
  launchctl(["enable", `${domain}/${MACOS_MENUBAR_LABEL}`], { ignoreError: true });
  // Fallback for older launchctl: unload/load the file if bootstrap did not take.
  if (!isLaunchdJobListed()) {
    launchctl(["load", "-w", path], { ignoreError: true });
  }
}

function isLaunchdJobListed(): boolean {
  try {
    execFileSync("launchctl", ["list", MACOS_MENUBAR_LABEL], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function pgrepExact(name: string): number[] {
  try {
    const out = execFileSync("pgrep", ["-x", name], { encoding: "utf8" }).trim();
    return out ? out.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

function pgrepPathFragment(fragment: string): number[] {
  try {
    const out = execFileSync("pgrep", ["-f", fragment], { encoding: "utf8" }).trim();
    return out ? out.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

/** Every live companion or leftover compile-check process. Never matches the proxy. */
export function macosMenubarCompanionPids(): number[] {
  const pids = new Set<number>();
  for (const name of MACOS_MENUBAR_STRAY_PROCESS_NAMES) {
    for (const pid of pgrepExact(name)) pids.add(pid);
  }
  for (const fragment of [macosMenubarExecutablePath(), `${MACOS_MENUBAR_APP_NAME}/Contents/MacOS/OpenCodex`]) {
    for (const pid of pgrepPathFragment(fragment)) pids.add(pid);
  }
  return [...pids];
}

function killPids(pids: readonly number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

export function stopAllMacosMenubarProcesses(): void {
  unloadPlist();
  killPids(macosMenubarCompanionPids());
  for (let attempt = 0; attempt < 10 && macosMenubarCompanionPids().length > 0; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    killPids(macosMenubarCompanionPids());
  }
  for (const pid of macosMenubarCompanionPids()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export function getMacosMenubarStatus(): MacosMenubarStatus {
  if (!isMacos()) {
    return {
      supported: false,
      installed: false,
      running: false,
      binaryExists: false,
      stale: false,
      processCount: 0,
      summary: "macOS menu bar is only available on macOS.",
    };
  }
  const installed = existsSync(plistPath());
  const binaryExists = existsSync(macosMenubarExecutablePath());
  const processCount = macosMenubarCompanionPids().length;
  const running = processCount > 0;
  const stale = installed && !plistMatchesCurrent();
  let summary: string;
  if (!installed) {
    summary = "Menu bar is not installed.";
  } else if (stale) {
    summary = "Menu bar is installed but its launchd job is stale; run `ocx menubar install` to repair.";
  } else if (processCount > 1) {
    summary = `Menu bar has ${processCount} processes; run \`ocx menubar install\` to collapse them to one.`;
  } else if (running) {
    summary = `Menu bar is installed and running on port ${currentProxyPort()}.`;
  } else {
    summary = "Menu bar is installed but not running.";
  }
  return { supported: true, installed, running, binaryExists, stale, processCount, summary };
}

function currentProxyPort(): number {
  const configDir = getConfigDir();
  const runtimePortPath = join(configDir, "runtime-port.json");
  try {
    if (existsSync(runtimePortPath)) {
      const parsed = JSON.parse(readFileSync(runtimePortPath, "utf8")) as { port?: number };
      if (typeof parsed.port === "number") return parsed.port;
    }
  } catch {
    // fall through
  }
  return 10100;
}

export async function installMacosMenubar(options: { noStart?: boolean } = {}): Promise<void> {
  assertMacos();
  stopAllMacosMenubarProcesses();
  buildAppBundle();
  loadPlist();
  if (!options.noStart && macosMenubarCompanionPids().length === 0) {
    startMacosMenubar();
  }
}

export function startMacosMenubar(): void {
  assertMacos();
  if (!existsSync(plistPath())) {
    throw new Error("Menubar is not installed. Run `ocx menubar install` first.");
  }
  if (macosMenubarCompanionPids().length > 0) return;
  launchctl(["start", MACOS_MENUBAR_LABEL], { ignoreError: true });
  launchctl(["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${MACOS_MENUBAR_LABEL}`], { ignoreError: true });
}

export function stopMacosMenubar(): void {
  assertMacos();
  stopAllMacosMenubarProcesses();
}

export function uninstallMacosMenubar(): void {
  assertMacos();
  stopAllMacosMenubarProcesses();
  rmSync(menubarDir(), { recursive: true, force: true });
  try { rmSync(plistPath()); } catch { /* Already gone. */ }
}

export interface MenubarCommandOptions {
  json?: boolean;
  noStart?: boolean;
}

export async function macosMenubarCommand(args: string[], options: MenubarCommandOptions = {}): Promise<void> {
  const subcommand = args[0];
  switch (subcommand) {
    case "install":
      await installMacosMenubar({ noStart: options.noStart });
      console.log("✅ OpenCodex menu bar installed." + (options.noStart ? " (not started)" : ""));
      break;
    case "start":
      startMacosMenubar();
      console.log("✅ OpenCodex menu bar started.");
      break;
    case "stop":
      stopMacosMenubar();
      console.log("✅ OpenCodex menu bar stopped.");
      break;
    case "status": {
      const status = getMacosMenubarStatus();
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(status.summary);
      }
      break;
    }
    case "uninstall":
    case "remove":
      uninstallMacosMenubar();
      console.log("✅ OpenCodex menu bar uninstalled.");
      break;
    default:
      console.error("Usage: ocx menubar <install|start|stop|status|uninstall|remove> [--json] [--no-start]");
      process.exitCode = 1;
  }
}
