import { repoPath } from "../helpers/repo-root";
import { describe, expect, test } from "bun:test";
import {
  MACOS_MENUBAR_APP_NAME,
  MACOS_MENUBAR_BUNDLE_ID,
  MACOS_MENUBAR_LABEL,
  MACOS_MENUBAR_STRAY_PROCESS_NAMES,
  macosMenubarAppPath,
  macosMenubarExecutablePath,
} from "../../src/tray/macos";

describe("macOS menubar install contract", () => {
  test("companion identity is a single launchd label and app bundle", () => {
    expect(MACOS_MENUBAR_LABEL).toBe("com.opencodex.menubar");
    expect(MACOS_MENUBAR_BUNDLE_ID).toBe("com.opencodex.menubar");
    expect(MACOS_MENUBAR_APP_NAME).toBe("OpenCodex.app");
    expect(macosMenubarAppPath().endsWith("/OpenCodex.app")).toBe(true);
    expect(macosMenubarExecutablePath().endsWith("/OpenCodex.app/Contents/MacOS/OpenCodex")).toBe(true);
  });

  test("install kills leftover compile-check binaries by exact name", () => {
    expect(MACOS_MENUBAR_STRAY_PROCESS_NAMES).toContain("opencodex-menubar");
    expect(MACOS_MENUBAR_STRAY_PROCESS_NAMES).toContain("ocx-menubar-build-check");
    expect(MACOS_MENUBAR_STRAY_PROCESS_NAMES).not.toContain("opencodex");
    expect(MACOS_MENUBAR_STRAY_PROCESS_NAMES).not.toContain("bun");
  });

  test("usage rows consume server-computed per-model timing and throughput", async () => {
    const source = await Bun.file(repoPath("src/tray/macos/menubar.swift")).text();
    expect(source).toContain("let modelCallMs: Int?");
    expect(source).toContain("let endToEndTokensPerSecond: Double?");
    expect(source).toContain("formatTps(model.endToEndTokensPerSecond)");
    expect(source).not.toContain("model.durationMs");
  });
});
