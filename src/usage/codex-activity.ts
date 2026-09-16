import { Database, constants } from "bun:sqlite";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCodexHomeDir } from "../codex/home";
import { unionDurationMs, type CodexTaskActivity } from "./summary";

/**
 * Codex task time: wall-clock the Codex CLI/app spent on user-visible turns,
 * reconstructed from rollout JSONL task events. Everything here reads state
 * OUTSIDE OpenCodex's control (the Codex thread index and rollout files), so
 * every failure — missing DB, locked DB, unreadable or malformed rollout —
 * degrades to "unavailable" (null) and never throws or logs per file.
 */

export interface CodexTaskEvent {
  kind: "started" | "terminal";
  /** turn_id; terminal events without one are anonymous completed intervals. */
  id: string | null;
  start: number;
  /** Terminal events only; started events extend to `now` while live. */
  end: number;
  /** Started events only: rollout file touched within the last 30 minutes. */
  live?: boolean;
}

const LIVE_ROLLOUT_MS = 30 * 60 * 1000;
const MAX_ROLLOUT_FILES = 512;
const MAX_ROLLOUT_FILE_BYTES = 16 * 1024 * 1024;
/** New (uncached) bytes read per collect call; the per-file cache amortizes the rest. */
const MAX_SCAN_BYTES_PER_COLLECT = 64 * 1024 * 1024;

const IMMUTABLE_READONLY_FLAGS = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;

const TASK_EVENT_MARKERS = ["\"task_started\"", "\"task_complete\"", "\"turn_aborted\""] as const;

/** Epoch heuristic shared by started_at/completed_at: values below 1e12 are seconds. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * One rollout JSONL line to a task event, or null when the line carries none.
 * Exported for tests; `live` is stamped by the collector from file mtime, not here.
 */
export function parseRolloutTaskEventLine(line: string): CodexTaskEvent | null {
  if (!TASK_EVENT_MARKERS.some(marker => line.includes(marker))) return null;
  let row: Record<string, unknown> | null;
  try {
    row = asRecord(JSON.parse(line));
  } catch {
    return null;
  }
  if (!row) return null;
  const payload = asRecord(row.payload) ?? row;
  const type = payload.type;
  if (type !== "task_started" && type !== "task_complete" && type !== "turn_aborted") return null;
  const id = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : null;
  const rowTs = toEpochMs(row.timestamp);
  const startedAt = toEpochMs(payload.started_at);
  if (type === "task_started") {
    const start = startedAt ?? rowTs;
    if (start === null) return null;
    return { kind: "started", id, start, end: start };
  }
  const durationMs = typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
    ? payload.duration_ms
    : null;
  const start = startedAt ?? rowTs;
  const end = toEpochMs(payload.completed_at)
    ?? rowTs
    ?? (start !== null && durationMs !== null ? start + durationMs : null);
  if (end === null) return null;
  const effectiveStart = start ?? (durationMs !== null ? end - durationMs : end);
  return { kind: "terminal", id, start: effectiveStart, end };
}

/**
 * The reference union-of-turns summarizer. A started turn without a terminal
 * event counts as active and extends to `now`, but only while live: its rollout
 * must have been touched within 30 minutes AND its start must fall inside the
 * range. The start-vs-cutoff half lives here, not at liveness stamping, because
 * one collected event set serves every range: an orphaned `task_started` from
 * before the window (its terminal event lost to a crash) inside a freshly
 * touched session file would otherwise count as a phantom turn spanning the
 * whole window.
 */
export function summarizeTaskEvents(
  events: readonly CodexTaskEvent[],
  { cutoff = -Infinity, now = Date.now() }: { cutoff?: number; now?: number } = {},
): CodexTaskActivity {
  const starts = new Map<string, CodexTaskEvent>();
  const terminals = new Map<string, [number, number]>();
  const anonymous: Array<[number, number]> = [];
  for (const event of events) {
    if (event.kind === "started") {
      if (event.id) {
        const previous = starts.get(event.id);
        if (!previous || (event.live && !previous.live)) starts.set(event.id, event);
      }
    } else if (event.id) terminals.set(event.id, [event.start, event.end]);
    else anonymous.push([event.start, event.end]);
  }
  const completedIntervals = [...terminals.values(), ...anonymous];
  const intervals = [...completedIntervals];
  let activeTurns = 0;
  for (const [id, event] of starts) {
    if (terminals.has(id)) continue;
    if (event.live === false) continue;
    if (event.start < cutoff || event.start > now) continue;
    intervals.push([event.start, now]);
    activeTurns++;
  }
  const clipped = intervals.map(([start, end]): [number, number] => [Math.max(start, cutoff), Math.min(end, now)]);
  return {
    activeWallMs: unionDurationMs(clipped),
    completedTurns: completedIntervals.filter(([s, e]) => e > cutoff && s < now).length,
    activeTurns,
  };
}

interface RolloutCacheEntry {
  size: number;
  mtimeMs: number;
  /** Parsed without liveness; `live` is stamped from mtime at collect time. */
  events: CodexTaskEvent[];
}

const rolloutEventCache = new Map<string, RolloutCacheEntry>();

/** Test-only: drop the per-file parse cache so fixtures re-read. */
export function resetCodexActivityCacheForTests(): void {
  rolloutEventCache.clear();
}

async function threadRollouts(codexHome: string): Promise<Array<{ path: string }> | null> {
  let dbPath: string | undefined;
  for (const candidate of [join(codexHome, "state_5.sqlite"), join(codexHome, "sqlite", "state_5.sqlite")]) {
    try {
      if ((await stat(candidate)).isFile()) { dbPath = candidate; break; }
    } catch { /* candidate absent */ }
  }
  if (!dbPath) return null;
  let db: Database | null = null;
  try {
    // Immutable readonly URI open — guarantees zero writes under CODEX_HOME
    // even for a WAL-mode DB with no sidecars yet (same pattern as scanner.ts).
    db = new Database(`${pathToFileURL(dbPath).href}?immutable=1`, IMMUTABLE_READONLY_FLAGS);
    const rows = db.query<{ rollout_path: string | null; updated_at_ms: number | null }, []>(
      `SELECT rollout_path, updated_at_ms FROM threads ORDER BY updated_at_ms DESC LIMIT ${MAX_ROLLOUT_FILES}`,
    ).all();
    const out: Array<{ path: string }> = [];
    for (const row of rows) {
      if (typeof row.rollout_path !== "string" || !row.rollout_path) continue;
      out.push({ path: isAbsolute(row.rollout_path) ? row.rollout_path : join(codexHome, row.rollout_path) });
    }
    return out;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already unusable */ }
  }
}

export interface CodexActivityOptions {
  /** Override for tests; defaults to the resolved CODEX_HOME. */
  codexHome?: string;
  now?: number;
}

/**
 * All task events across the indexed rollouts, or null when the thread index
 * is unavailable. Per-file failures skip that file; parse results are cached
 * by size+mtime so a steady state costs stats, not reads. Async on purpose:
 * this runs on the proxy's event loop next to live streaming responses, and a
 * cold cache can read tens of megabytes.
 */
export async function collectCodexTaskEvents(options: CodexActivityOptions = {}): Promise<CodexTaskEvent[] | null> {
  try {
    const codexHome = options.codexHome ?? resolveCodexHomeDir();
    const rollouts = await threadRollouts(codexHome);
    if (!rollouts) return null;
    const now = options.now ?? Date.now();
    const events: CodexTaskEvent[] = [];
    let scanBudget = MAX_SCAN_BYTES_PER_COLLECT;
    for (const { path } of rollouts) {
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_ROLLOUT_FILE_BYTES) continue;
        let cached = rolloutEventCache.get(path);
        if (!cached || cached.size !== info.size || cached.mtimeMs !== info.mtimeMs) {
          if (info.size > scanBudget) continue;
          scanBudget -= info.size;
          const parsed: CodexTaskEvent[] = [];
          for (const line of (await readFile(path, "utf8")).split("\n")) {
            const event = parseRolloutTaskEventLine(line);
            if (event) parsed.push(event);
          }
          cached = { size: info.size, mtimeMs: info.mtimeMs, events: parsed };
          rolloutEventCache.set(path, cached);
        }
        const live = now - cached.mtimeMs <= LIVE_ROLLOUT_MS;
        for (const event of cached.events) {
          events.push(event.kind === "started" ? { ...event, live } : event);
        }
      } catch {
        // Unreadable or vanished rollout: skip it, keep the rest.
      }
    }
    return events;
  } catch {
    return null;
  }
}

/** Convenience: collect + summarize for one range cutoff; null when unavailable. */
export async function codexTaskActivity(cutoff: number | null, options: CodexActivityOptions = {}): Promise<CodexTaskActivity | null> {
  const events = await collectCodexTaskEvents(options);
  if (!events) return null;
  return summarizeTaskEvents(events, { cutoff: cutoff ?? -Infinity, now: options.now ?? Date.now() });
}
