import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeUsage, unionDurationMs } from "../src/usage/summary";
import {
  codexTaskActivity,
  parseRolloutTaskEventLine,
  resetCodexActivityCacheForTests,
  summarizeTaskEvents,
  type CodexTaskEvent,
} from "../src/usage/codex-activity";
import type { PersistedUsageEntry } from "../src/usage/log";

const FIXED_NOW = Date.UTC(2026, 5, 28, 12, 0, 0);

function entry(overrides: Partial<PersistedUsageEntry> & { ts: number }): PersistedUsageEntry {
  const { ts, ...rest } = overrides;
  return {
    requestId: rest.requestId ?? `req-${ts}-${Math.random()}`,
    timestamp: ts,
    provider: rest.provider ?? "openai",
    model: rest.model ?? "gpt-5.5",
    status: rest.status ?? 200,
    durationMs: rest.durationMs ?? 10,
    usageStatus: rest.usageStatus ?? "reported",
    ...(rest.firstOutputMs !== undefined ? { firstOutputMs: rest.firstOutputMs } : {}),
    ...(rest.terminalStatus !== undefined ? { terminalStatus: rest.terminalStatus } : {}),
    ...(rest.resolvedModel !== undefined ? { resolvedModel: rest.resolvedModel } : {}),
    ...(rest.requestedEffort !== undefined ? { requestedEffort: rest.requestedEffort } : {}),
    ...(rest.effectiveEffort !== undefined ? { effectiveEffort: rest.effectiveEffort } : {}),
    ...(rest.tierOutcome !== undefined ? { tierOutcome: rest.tierOutcome } : {}),
    ...(rest.attempts !== undefined ? { attempts: rest.attempts } : {}),
    ...(rest.usage ? { usage: rest.usage } : {}),
  };
}

describe("unionDurationMs", () => {
  test("merges overlapping intervals and keeps disjoint ones", () => {
    expect(unionDurationMs([[0, 1000], [500, 2000], [3000, 3500]])).toBe(2500);
  });

  test("empty and inverted intervals contribute nothing", () => {
    expect(unionDurationMs([])).toBe(0);
    expect(unionDurationMs([[1000, 1000], [2000, 1000]])).toBe(0);
  });
});

describe("summarizeUsage latency", () => {
  test("apiActiveMs unions overlap while modelCallMs double-counts it", () => {
    const entries = [
      entry({ ts: FIXED_NOW, durationMs: 2000, usage: { inputTokens: 10, outputTokens: 5 } }),
      entry({ ts: FIXED_NOW + 1000, durationMs: 2000, usage: { inputTokens: 10, outputTokens: 5 } }),
    ];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 5000);
    expect(sum.latency.modelCallMs).toBe(4000);
    expect(sum.latency.apiActiveMs).toBe(3000);
  });

  test("throughput is token-weighted, not the mean of per-request rates", () => {
    const entries = [
      entry({ ts: FIXED_NOW, durationMs: 1000, usage: { inputTokens: 1, outputTokens: 100 } }),
      entry({ ts: FIXED_NOW + 10_000, durationMs: 4000, usage: { inputTokens: 1, outputTokens: 100 } }),
    ];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 20_000);
    // 200 tokens over 5000 ms = 40 tok/s; the mean of per-request rates would be 62.5.
    expect(sum.latency.endToEndTokensPerSecond).toBe(40);
  });

  test("firstOutputMs of exactly 0 is a valid TTFT and still yields a decode rate", () => {
    const entries = [entry({
      ts: FIXED_NOW,
      durationMs: 1000,
      firstOutputMs: 0,
      usage: { inputTokens: 1, outputTokens: 50 },
    })];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 5000);
    expect(sum.latency.averageTtftMs).toBe(0);
    expect(sum.latency.decodeTokensPerSecond).toBe(50);
  });

  test("firstOutputMs beyond durationMs is excluded from TTFT and decode, not from end-to-end", () => {
    const entries = [entry({
      ts: FIXED_NOW,
      durationMs: 1000,
      firstOutputMs: 1500,
      usage: { inputTokens: 1, outputTokens: 100 },
    })];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 5000);
    expect(sum.latency.averageTtftMs).toBeNull();
    expect(sum.latency.decodeTokensPerSecond).toBeNull();
    expect(sum.latency.endToEndTokensPerSecond).toBe(100);
  });

  test("firstOutputMs equal to durationMs counts for TTFT and end-to-end but not decode", () => {
    const entries = [entry({
      ts: FIXED_NOW,
      durationMs: 1000,
      firstOutputMs: 1000,
      usage: { inputTokens: 1, outputTokens: 100 },
    })];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 5000);
    expect(sum.latency.averageTtftMs).toBe(1000);
    expect(sum.latency.endToEndTokensPerSecond).toBe(100);
    expect(sum.latency.decodeTokensPerSecond).toBeNull();
  });

  test("500s and unreported rows are excluded from rates but counted as requests", () => {
    const entries = [
      entry({ ts: FIXED_NOW, durationMs: 1000, firstOutputMs: 200, usage: { inputTokens: 1, outputTokens: 100 } }),
      entry({ ts: FIXED_NOW + 10_000, status: 500, durationMs: 9000, firstOutputMs: 10, usage: { inputTokens: 1, outputTokens: 999 } }),
      entry({ ts: FIXED_NOW + 30_000, usageStatus: "unreported", durationMs: 9000, firstOutputMs: 10 }),
    ];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 60_000);
    expect(sum.summary.requests).toBe(3);
    expect(sum.latency.modelCallMs).toBe(19_000);
    expect(sum.latency.averageTtftMs).toBe(200);
    expect(sum.latency.endToEndTokensPerSecond).toBe(100);
  });

  test("non-completed terminalStatus is excluded from rates", () => {
    const entries = [
      entry({ ts: FIXED_NOW, durationMs: 1000, terminalStatus: "aborted", usage: { inputTokens: 1, outputTokens: 100 } }),
      entry({ ts: FIXED_NOW + 5000, durationMs: 2000, terminalStatus: "completed", usage: { inputTokens: 1, outputTokens: 100 } }),
    ];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 10_000);
    expect(sum.latency.endToEndTokensPerSecond).toBe(50);
  });

  test("no qualifying rows yields nulls, never zeros", () => {
    const sum = summarizeUsage([entry({ ts: FIXED_NOW, status: 500 })], "all", FIXED_NOW + 1000);
    expect(sum.latency.averageTtftMs).toBeNull();
    expect(sum.latency.endToEndTokensPerSecond).toBeNull();
    expect(sum.latency.decodeTokensPerSecond).toBeNull();
    expect(sum.latency.activeWallMs).toBeNull();
    expect(sum.latency.activeTurns).toBe(0);
    expect(sum.latency.completedTurns).toBe(0);
  });

  test("reports token-weighted throughput for each model", () => {
    const entries = [
      entry({ ts: FIXED_NOW, provider: "alpha", model: "fast", durationMs: 1000, firstOutputMs: 200, usage: { inputTokens: 1, outputTokens: 100 } }),
      entry({ ts: FIXED_NOW + 2000, provider: "alpha", model: "fast", durationMs: 3000, firstOutputMs: 1000, usage: { inputTokens: 1, outputTokens: 100 } }),
      entry({ ts: FIXED_NOW + 6000, provider: "beta", model: "slow", durationMs: 4000, firstOutputMs: 2000, usage: { inputTokens: 1, outputTokens: 20 } }),
      entry({ ts: FIXED_NOW + 11_000, provider: "beta", model: "slow", status: 500, durationMs: 10, firstOutputMs: 1, usage: { inputTokens: 1, outputTokens: 999 } }),
    ];

    const models = summarizeUsage(entries, "all", FIXED_NOW + 20_000).models;
    expect(models.find(row => row.model === "fast")).toMatchObject({
      modelCallMs: 4000,
      averageTtftMs: 600,
      endToEndTokensPerSecond: 50,
      decodeTokensPerSecond: 200 / 2.8,
    });
    expect(models.find(row => row.model === "slow")).toMatchObject({
      modelCallMs: 4010,
      averageTtftMs: 2000,
      endToEndTokensPerSecond: 5,
      decodeTokensPerSecond: 10,
    });
  });

  test("attributes combo throughput to physical attempts without counting the parent", () => {
    const sum = summarizeUsage([entry({
      ts: FIXED_NOW,
      provider: "combo",
      model: "fallback",
      durationMs: 9000,
      firstOutputMs: 1000,
      usage: { inputTokens: 999, outputTokens: 999 },
      attempts: [
        { ordinal: 1, provider: "alpha", model: "failed", adapter: "openai-chat", status: 500, durationMs: 1000, firstOutputMs: 100, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 100 } },
        { ordinal: 2, provider: "beta", model: "winner", adapter: "openai-chat", status: 200, durationMs: 2000, firstOutputMs: 500, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 2, outputTokens: 60 } },
      ],
    })], "all", FIXED_NOW + 20_000);

    expect(sum.models).toHaveLength(2);
    expect(sum.models.find(row => row.model === "failed")).toMatchObject({
      modelCallMs: 1000,
      endToEndTokensPerSecond: null,
      decodeTokensPerSecond: null,
    });
    expect(sum.models.find(row => row.model === "winner")).toMatchObject({
      modelCallMs: 2000,
      endToEndTokensPerSecond: 30,
      decodeTokensPerSecond: 40,
    });
    expect(sum.models.find(row => row.model === "fallback")).toBeUndefined();
  });
});

describe("summarizeUsage effortGroups", () => {
  test("groups by provider, model, speed, and effort with not-recorded defaults", () => {
    const entries = [
      entry({ ts: FIXED_NOW, model: "gpt-5.5", requestedEffort: "high", effectiveEffort: "high", durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } }),
      entry({ ts: FIXED_NOW + 1, model: "gpt-5.5", requestedEffort: "high", effectiveEffort: "high", durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } }),
      entry({ ts: FIXED_NOW + 2, model: "gpt-5.5", requestedEffort: "high", effectiveEffort: "high", durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } }),
      entry({ ts: FIXED_NOW + 3, model: "alias", resolvedModel: "gpt-5.5-real", durationMs: 200, usage: { inputTokens: 1, outputTokens: 1 } }),
    ];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 1000);
    expect(sum.effortGroups).toHaveLength(2);
    const [top, second] = sum.effortGroups;
    expect(top!.provider).toBe("openai");
    expect(top!.speedMode).toBe("unknown");
    expect(top!.model).toBe("gpt-5.5");
    expect(top!.requestedEffort).toBe("high");
    expect(top!.effectiveEffort).toBe("high");
    expect(top!.requests).toBe(3);
    expect(top!.requestShare).toBe(75);
    expect(top!.modelCallMs).toBe(300);
    expect(top!.inputTokens).toBe(30);
    expect(top!.outputTokens).toBe(15);
    expect(second!.model).toBe("gpt-5.5-real");
    expect(second!.requestedEffort).toBe("not-recorded");
    expect(second!.effectiveEffort).toBe("not-recorded");
    expect(second!.requestShare).toBe(25);
  });

  test("a different effectiveEffort is a different group even for the same model", () => {
    const entries = [
      entry({ ts: FIXED_NOW, requestedEffort: "high", effectiveEffort: "high" }),
      entry({ ts: FIXED_NOW + 1, requestedEffort: "high", effectiveEffort: "medium" }),
    ];
    const sum = summarizeUsage(entries, "all", FIXED_NOW + 1000);
    expect(sum.effortGroups).toHaveLength(2);
  });

  test("separates Fast and standard TTFT for the same Enterprise model and effort", () => {
    const shared = { provider: "openai", model: "gpt-5.6-sol", requestedEffort: "high", effectiveEffort: "high" };
    const entries = [
      entry({ ...shared, ts: FIXED_NOW, durationMs: 1000, firstOutputMs: 200, usage: { inputTokens: 10, outputTokens: 20 }, tierOutcome: { canonical: "priority", wireKind: "service-tier", wireValue: "priority", fastOutcome: "applied", confirmation: "confirmed", responseServiceTier: "priority" } }),
      entry({ ...shared, ts: FIXED_NOW + 2000, durationMs: 1000, firstOutputMs: 600, usage: { inputTokens: 10, outputTokens: 20 }, tierOutcome: { wireKind: null, wireValue: null, fastOutcome: "not-requested", confirmation: "unknown", responseServiceTier: "default" } }),
    ];

    const groups = summarizeUsage(entries, "all", FIXED_NOW + 5000).effortGroups;
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.speedMode === "fast")?.averageTtftMs).toBe(200);
    expect(groups.find(group => group.speedMode === "standard")?.averageTtftMs).toBe(600);
  });

  test("the same model and effort remain separate across providers", () => {
    const entries = [
      entry({ ts: FIXED_NOW, provider: "work", model: "gpt-5.5", requestedEffort: "high", effectiveEffort: "high" }),
      entry({ ts: FIXED_NOW + 1, provider: "litellm", model: "gpt-5.5", requestedEffort: "high", effectiveEffort: "high" }),
    ];

    const groups = summarizeUsage(entries, "all", FIXED_NOW + 1000).effortGroups;
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.provider).sort()).toEqual(["litellm", "work"]);
    expect(groups.every(group => group.requests === 1 && group.requestShare === 50)).toBe(true);
  });

  test("same-provider retries count as one request while retaining physical call time", () => {
    const groups = summarizeUsage([entry({
      ts: FIXED_NOW,
      provider: "combo",
      model: "fallback",
      attempts: [
        { ordinal: 1, provider: "work", model: "gpt-5.5", adapter: "openai-responses", status: 500, durationMs: 100, sendCount: 1, recoveryKinds: [], usageStatus: "unreported", requestedEffort: "high", effectiveEffort: "high" },
        { ordinal: 2, provider: "work", model: "gpt-5.5", adapter: "openai-responses", status: 200, durationMs: 200, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 2, outputTokens: 3 }, requestedEffort: "high", effectiveEffort: "high" },
      ],
    })], "all", FIXED_NOW + 1000).effortGroups;

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ provider: "work", requests: 1, requestShare: 100, modelCallMs: 300 });
  });

  test("a combo request spanning providers uses one logical request as the share denominator", () => {
    const groups = summarizeUsage([entry({
      ts: FIXED_NOW,
      provider: "combo",
      model: "fallback",
      attempts: [
        { ordinal: 1, provider: "work", model: "gpt-5.5", adapter: "openai-responses", status: 500, durationMs: 100, sendCount: 1, recoveryKinds: [], usageStatus: "unreported", requestedEffort: "high", effectiveEffort: "high" },
        { ordinal: 2, provider: "litellm", model: "gpt-5.5", adapter: "openai-responses", status: 200, durationMs: 200, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 2, outputTokens: 3 }, requestedEffort: "high", effectiveEffort: "high" },
      ],
    })], "all", FIXED_NOW + 1000).effortGroups;

    expect(groups).toHaveLength(2);
    expect(groups.every(group => group.requests === 1 && group.requestShare === 100)).toBe(true);
  });
});

describe("summarizeTaskEvents", () => {
  test("started/complete/started unions to 180s with 1 completed and 1 active turn", () => {
    const now = FIXED_NOW;
    const events: CodexTaskEvent[] = [
      { kind: "started", id: "turn-a", start: now - 600_000, end: now - 600_000, live: true },
      { kind: "terminal", id: "turn-a", start: now - 600_000, end: now - 480_000 },
      { kind: "started", id: "turn-b", start: now - 60_000, end: now - 60_000, live: true },
    ];
    const result = summarizeTaskEvents(events, { now });
    expect(result.activeWallMs).toBe(180_000);
    expect(result.completedTurns).toBe(1);
    expect(result.activeTurns).toBe(1);
  });

  test("a non-live open turn is dropped instead of extending to now", () => {
    const now = FIXED_NOW;
    const events: CodexTaskEvent[] = [
      { kind: "started", id: "stale", start: now - 3_600_000, end: now - 3_600_000, live: false },
    ];
    const result = summarizeTaskEvents(events, { now });
    expect(result.activeWallMs).toBe(0);
    expect(result.activeTurns).toBe(0);
  });

  test("an orphaned start from before the cutoff is dropped even when its rollout is live", () => {
    // Codex crashed mid-turn three days ago (terminal event lost), but the same
    // session file was touched today so mtime-liveness alone marks it live. It
    // must contribute nothing to "today" — not a window-spanning active turn.
    const now = FIXED_NOW;
    const cutoff = now - 12 * 3_600_000;
    const events: CodexTaskEvent[] = [
      { kind: "started", id: "orphan", start: now - 3 * 86_400_000, end: now - 3 * 86_400_000, live: true },
    ];
    const result = summarizeTaskEvents(events, { cutoff, now });
    expect(result.activeWallMs).toBe(0);
    expect(result.activeTurns).toBe(0);
    expect(result.completedTurns).toBe(0);
  });

  test("intervals clamp to the cutoff and completed turns before it are excluded", () => {
    const now = FIXED_NOW;
    const cutoff = now - 100_000;
    const events: CodexTaskEvent[] = [
      { kind: "terminal", id: "old", start: now - 500_000, end: now - 400_000 },
      { kind: "terminal", id: "straddling", start: now - 150_000, end: now - 50_000 },
    ];
    const result = summarizeTaskEvents(events, { cutoff, now });
    expect(result.activeWallMs).toBe(50_000);
    expect(result.completedTurns).toBe(1);
  });
});

describe("parseRolloutTaskEventLine", () => {
  test("epoch-seconds started_at is scaled to milliseconds", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-28T12:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "t1", started_at: 1_750_000_000 },
    });
    const event = parseRolloutTaskEventLine(line);
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("started");
    expect(event!.id).toBe("t1");
    expect(event!.start).toBe(1_750_000_000_000);
  });

  test("terminal events fall back to the row timestamp for their end", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-28T12:00:00.000Z",
      payload: { type: "task_complete", turn_id: "t1", started_at: 1_750_000_000_000 },
    });
    const event = parseRolloutTaskEventLine(line);
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("terminal");
    expect(event!.start).toBe(1_750_000_000_000);
    expect(event!.end).toBe(Date.parse("2026-06-28T12:00:00.000Z"));
  });

  test("unrelated and malformed lines yield null", () => {
    expect(parseRolloutTaskEventLine("{\"type\":\"message\"}")).toBeNull();
    expect(parseRolloutTaskEventLine("not json \"task_started\"")).toBeNull();
    expect(parseRolloutTaskEventLine("")).toBeNull();
  });
});

describe("codexTaskActivity", () => {
  const tempDirs: string[] = [];

  function tempCodexHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "ocx-codex-activity-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    resetCodexActivityCacheForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("degrades to null when the sqlite DB is absent", async () => {
    expect(await codexTaskActivity(null, { codexHome: tempCodexHome() })).toBeNull();
  });

  test("degrades to null when the DB file is not a database", async () => {
    const home = tempCodexHome();
    writeFileSync(join(home, "state_5.sqlite"), "definitely not sqlite");
    expect(await codexTaskActivity(null, { codexHome: home })).toBeNull();
  });

  test("reads task events from indexed rollouts and unions the completed turn", async () => {
    const home = tempCodexHome();
    const now = Date.now();
    mkdirSync(join(home, "rollouts"));
    const startedAtSeconds = Math.floor((now - 120_000) / 1000);
    const completedAtMs = startedAtSeconds * 1000 + 60_000;
    writeFileSync(join(home, "rollouts", "r1.jsonl"), [
      JSON.stringify({ timestamp: new Date(now - 120_000).toISOString(), payload: { type: "task_started", turn_id: "t1", started_at: startedAtSeconds } }),
      JSON.stringify({ timestamp: new Date(completedAtMs).toISOString(), payload: { type: "task_complete", turn_id: "t1", started_at: startedAtSeconds, completed_at: completedAtMs } }),
      "not json",
      JSON.stringify({ payload: { type: "message" } }),
    ].join("\n"));
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (rollout_path TEXT, updated_at_ms INTEGER)");
    db.query("INSERT INTO threads (rollout_path, updated_at_ms) VALUES (?, ?)").run("rollouts/r1.jsonl", now);
    db.close();

    const activity = await codexTaskActivity(null, { codexHome: home, now });
    expect(activity).not.toBeNull();
    expect(activity!.activeWallMs).toBe(60_000);
    expect(activity!.completedTurns).toBe(1);
    expect(activity!.activeTurns).toBe(0);
  });

  test("an unreadable rollout is skipped without failing the collection", async () => {
    const home = tempCodexHome();
    const now = Date.now();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (rollout_path TEXT, updated_at_ms INTEGER)");
    db.query("INSERT INTO threads (rollout_path, updated_at_ms) VALUES (?, ?)").run("rollouts/missing.jsonl", now);
    db.close();
    const activity = await codexTaskActivity(null, { codexHome: home, now });
    expect(activity).toEqual({ activeWallMs: 0, completedTurns: 0, activeTurns: 0 });
  });
});
