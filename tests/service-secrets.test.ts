import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readServiceApiTokenState,
  removeServiceApiTokenFileIfOwned,
  serviceApiTokenFilePath,
  serviceApiTokenFingerprint,
  writeServiceApiTokenFile,
} from "../src/lib/service-secrets";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-service-secret-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("service API token ownership", () => {
  test("writes only the exact owner path through an atomic owner-only replacement", () => {
    const token = "ocx_data_0123456789abcdef0123456789abcdef01234567";
    const persisted = writeServiceApiTokenFile(token);

    expect(persisted.path).toBe(join(home, "service-api-token"));
    expect(persisted.path).toBe(serviceApiTokenFilePath());
    expect(persisted.fingerprint).toBe(serviceApiTokenFingerprint(token));
    expect(lstatSync(persisted.path).isFile()).toBe(true);
    if (process.platform !== "win32") expect(lstatSync(persisted.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter(name => name.includes(".tmp"))).toEqual([]);
    expect(readServiceApiTokenState()).toEqual({
      kind: "present",
      token,
      fingerprint: persisted.fingerprint,
    });
  });

  test("refuses symlink and pre-existing token targets without exposing token bytes", () => {
    const path = serviceApiTokenFilePath();
    const target = join(home, "foreign-token");
    writeFileSync(target, "foreign-secret\n", { mode: 0o600 });
    let symlinkAvailable = true;
    try {
      symlinkSync(target, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") symlinkAvailable = false;
      else throw error;
    }
    if (symlinkAvailable) {
      const secret = "ocx_data_should_never_appear_in_an_error";
      expect(() => writeServiceApiTokenFile(secret)).toThrow("bounded regular file");
      try { writeServiceApiTokenFile(secret); } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
      rmSync(path);
    }

    writeFileSync(path, "foreign-secret\n", { mode: 0o600 });
    expect(() => writeServiceApiTokenFile("ocx_data_new_secret")).toThrow("pre-existing");
  });

  test("removes only the fingerprint-owned unchanged token", () => {
    const first = writeServiceApiTokenFile("ocx_data_first");
    writeFileSync(first.path, "ocx_data_replacement\n", { mode: 0o600 });
    expect(removeServiceApiTokenFileIfOwned(first.fingerprint)).toBe("changed");
    expect(existsSync(first.path)).toBe(true);

    const replacementFingerprint = serviceApiTokenFingerprint("ocx_data_replacement");
    expect(removeServiceApiTokenFileIfOwned(replacementFingerprint)).toBe("removed");
    expect(existsSync(first.path)).toBe(false);
    expect(removeServiceApiTokenFileIfOwned(replacementFingerprint)).toBe("absent");
  });
});
