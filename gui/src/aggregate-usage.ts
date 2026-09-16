import type { UsageResponse, UsageDay, UsageModel, UsageProvider, UsageEffortGroup } from "./usage-report";

const counters = ["requests", "measuredRequests", "reportedRequests", "estimatedRequests", "inputTokens", "outputTokens", "totalTokens"];
const rates = ["averageTtftMs", "endToEndTokensPerSecond", "decodeTokensPerSecond"];
function sum(rows: object[], key: string): number | undefined {
  const values = rows.map(row => (row as Record<string, unknown>)[key]);
  return values.every(value => typeof value === "number" && Number.isFinite(value)) ? (values as number[]).reduce((a, b) => a + b, 0) : undefined;
}
function merged<T extends object>(rows: T[], identity: (row: T) => string, fields: string[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) { const key = identity(row); groups.set(key, [...(groups.get(key) ?? []), row]); }
  return [...groups.values()].map(group => {
    const row = { ...group[0] } as Record<string, unknown>;
    for (const key of fields) row[key] = sum(group, key);
    // Public reports omit the sample counts/durations behind these derived rates.
    if (group.length > 1) for (const key of rates) if (key in row) row[key] = null;
    return row as T;
  });
}

/** Aggregate recorded proxy rows, including relay duplicates; this is not unique inference usage. */
export function aggregateUsage(reports: UsageResponse[]): UsageResponse | null {
  if (!reports.length) return null;
  if (reports.length === 1) return reports[0];
  const first = reports[0];
  const summary = { ...first.summary };
  for (const key of [...counters, "unreportedRequests", "unsupportedRequests", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens", "estimatedCostUsd", "pricedRequests", "unpricedRequests", "unmeteredRequests"]) {
    (summary as unknown as Record<string, unknown>)[key] = sum(reports.map(report => report.summary), key);
  }
  summary.coverageRatio = summary.requests ? summary.measuredRequests / summary.requests : 0;
  const modelKey = (row: { provider: string; model: string; resolvedModel?: string }) => JSON.stringify([row.provider, row.model, row.resolvedModel]);
  const models = merged<UsageModel>(reports.flatMap(report => report.models), modelKey, [...counters, "modelCallMs"]);
  const providers = merged<UsageProvider>(reports.flatMap(report => report.providers), row => row.provider, counters);
  for (const row of [...models, ...providers]) row.shareRatio = summary.totalTokens ? row.totalTokens / summary.totalTokens : 0;
  const days = merged<UsageDay>(reports.flatMap(report => report.days), row => row.date, counters).sort((a, b) => a.date.localeCompare(b.date));
  for (const day of days) day.models = merged(reports.flatMap(report => report.days.filter(row => row.date === day.date).flatMap(row => row.models)), modelKey, ["requests", "totalTokens"]);
  const effortGroups = reports.every(report => report.effortGroups !== undefined) ? merged<UsageEffortGroup>(reports.flatMap(report => report.effortGroups!), row => JSON.stringify([row.provider, row.model, row.speedMode, row.requestedEffort, row.effectiveEffort]), ["requests", "modelCallMs", "inputTokens", "outputTokens"]) : undefined;
  for (const row of effortGroups ?? []) row.requestShare = summary.requests ? row.requests / summary.requests * 100 : 0;
  const latency = reports.every(report => report.latency !== undefined) ? {
    modelCallMs: sum(reports.map(report => report.latency!), "modelCallMs") ?? null,
    activeTurns: sum(reports.map(report => report.latency!), "activeTurns") ?? null,
    completedTurns: sum(reports.map(report => report.latency!), "completedTurns") ?? null,
    // The API provides each machine's interval union, not the intervals needed for a global union.
    apiActiveMs: null, activeWallMs: null, averageTtftMs: null, endToEndTokensPerSecond: null, decodeTokensPerSecond: null,
  } : undefined;
  return { ...first, summary, models, providers, days, effortGroups, latency,
    generatedAt: Math.min(...reports.map(report => report.generatedAt)),
    historyTruncated: reports.some(report => report.historyTruncated),
    usageIncomplete: reports.some(report => report.usageIncomplete) ? true : undefined,
    usageIncompleteReason: reports.some(report => report.usageIncompleteReason === "oversized_rows") ? "oversized_rows" : undefined,
    entriesTruncated: reports.some(report => report.entriesTruncated),
    truncatedPrefixBytes: reports.reduce((total, report) => total + (report.truncatedPrefixBytes ?? 0), 0),
    entriesDropped: reports.reduce((total, report) => total + (report.entriesDropped ?? 0), 0),
    snapshotWindowStart: undefined, snapshotWindowEnd: undefined,
  };
}
