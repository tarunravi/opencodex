import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRemoteUsage, readUsageRemotes } from "../../src/usage/remote-instances";

describe("remote usage", () => {
  let configDir: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const token = "test-management-token";
  const query = { range: "7d", surface: "codex" } as const;
  const summary = { requests: 3, inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14, estimatedCostUsd: 0.2 };
  const payload = () => ({ ...query, summary, secret: token, models: [{ arbitrary: token }] });
  const options = () => ({ configDir, timeoutMs: 500 });
  async function configure(fetch: (request: Request) => Response | Promise<Response>) {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
    await writeFile(join(configDir, "usage-remotes.json"), JSON.stringify([
      { id: "devbox", name: "Devbox", baseUrl: server.url.origin, token },
    ]), { mode: 0o600 });
  }
  beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "ocx-remote-usage-")); });
  afterEach(async () => { server?.stop(true); server = undefined; await rm(configDir, { recursive: true, force: true }); });

  test("sends management authentication and filters; exposes only numeric summary", async () => {
    await configure(request => {
      expect(request.headers.get("x-opencodex-api-key")).toBe(token);
      expect(new URL(request.url).pathname).toBe("/api/usage");
      expect(new URL(request.url).searchParams.get("range")).toBe("7d");
      expect(new URL(request.url).searchParams.get("surface")).toBe("codex");
      return Response.json(payload());
    });
    const result = await collectRemoteUsage(query, options());
    expect(result).toEqual({ remotes: [{ id: "devbox", name: "Devbox", usage: { summary } }] });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  test("projects partial history and timezone metadata", async () => {
    await configure(() => Response.json({ ...payload(), historyTruncated: true, usageIncomplete: true, timeZone: "America/Los_Angeles" }));
    expect((await collectRemoteUsage(query, options())).remotes[0]?.usage).toEqual({ summary, historyTruncated: true, usageIncomplete: true, timeZone: "America/Los_Angeles" });
  });

  test("absent config means no remotes; malformed or insecure config is visible", async () => {
    expect(await readUsageRemotes(configDir)).toEqual([]);
    await writeFile(join(configDir, "usage-remotes.json"), "broken", { mode: 0o600 });
    expect(await collectRemoteUsage(query, options())).toEqual({ remotes: [], error: "invalid_config" });
    if (process.platform !== "win32") {
      await writeFile(join(configDir, "usage-remotes.json"), "[]");
      await chmod(join(configDir, "usage-remotes.json"), 0o644);
      expect(await collectRemoteUsage(query, options())).toEqual({ remotes: [], error: "invalid_config" });
    }
  });

  test.each(["http://example.com", "https://127.0.0.1", "http://127.0.0.1/secret", "http://user:pass@127.0.0.1", "http://127.0.0.1?secret=yes"])("rejects unsupported destination %s", async baseUrl => {
    await writeFile(join(configDir, "usage-remotes.json"), JSON.stringify([{ id: "devbox", name: "Devbox", baseUrl, token }]), { mode: 0o600 });
    expect((await collectRemoteUsage(query, options())).error).toBe("invalid_config");
  });

  test.each([401, 403, 500])("maps HTTP %i without disclosing upstream body", async status => {
    await configure(() => new Response(token, { status }));
    expect((await collectRemoteUsage(query, options())).remotes[0]?.error).toBe(status === 500 ? "unavailable" : "unauthorized");
  });

  test("does not follow redirects", async () => {
    let calls = 0;
    await configure(() => { calls++; return Response.redirect(`${server!.url.origin}/stolen`); });
    expect((await collectRemoteUsage(query, options())).remotes[0]?.error).toBe("unavailable");
    expect(calls).toBe(1);
  });

  test.each(["not json", JSON.stringify({ ...query, summary: { ...summary, totalTokens: -1 } }), JSON.stringify({ ...query, summary: { ...summary, requests: "3" } }), "x".repeat(1024 * 1024 + 1)])("rejects invalid or oversized body %#", async body => {
    await configure(() => new Response(body));
    expect((await collectRemoteUsage(query, options())).remotes[0]?.error).toBe("invalid_response");
  });

  test("rejects a successful HTTP response carrying a ledger read error instead of reporting zero usage", async () => {
    await configure(() => Response.json({ ...payload(), error: "read_failed", summary: { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } }));
    const result = await collectRemoteUsage(query, options());
    expect(result.remotes[0]?.error).toBe("invalid_response");
    expect(result.remotes[0]?.usage).toBeUndefined();
  });

  test("deadline covers streaming body", async () => {
    await configure(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } })));
    expect((await collectRemoteUsage(query, { configDir, timeoutMs: 30 })).remotes[0]?.error).toBe("timeout");
  });

  test("explicit bounds must be honored by remote", async () => {
    let echo = false;
    await configure(request => {
      expect(new URL(request.url).searchParams.get("since")).toBe("100");
      expect(new URL(request.url).searchParams.get("until")).toBe("200");
      return Response.json({ ...payload(), ...(echo ? { customWindow: true, since: 100, until: 200 } : {}) });
    });
    const bounded = { ...query, since: 100, until: 200 };
    expect((await collectRemoteUsage(bounded, options())).remotes[0]?.error).toBe("unsupported_window");
    echo = true;
    expect((await collectRemoteUsage(bounded, options())).remotes[0]?.usage?.summary).toEqual(summary);
    await expect(collectRemoteUsage({ ...query, since: 200, until: 100 }, options())).rejects.toThrow();
  });

  test("offline remote returns error without preventing successful peers", async () => {
    await configure(() => Response.json(payload()));
    const remotes = await readUsageRemotes(configDir);
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const closedUrl = closed.url.origin;
    closed.stop(true);
    await writeFile(join(configDir, "usage-remotes.json"), JSON.stringify([...remotes, { ...remotes[0], id: "offline", baseUrl: closedUrl }]));
    const result = await collectRemoteUsage(query, options());
    expect(result.remotes[0]?.usage?.summary).toEqual(summary);
    expect(result.remotes[1]?.error).toBe("unavailable");
  });
});
