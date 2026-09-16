// Only dashboard accounting fields cross the remote boundary. Unknown keys, account labels,
// request payloads and server configuration never become part of the browser response.
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("invalid_response");
  return value;
}
function numbers(value: unknown, required: string[], optional: string[] = [], nullable: string[] = []) {
  const source = object(value);
  const result: Record<string, unknown> = {};
  for (const key of [...required, ...optional, ...nullable]) {
    const n = source[key];
    if (n === undefined && !required.includes(key)) continue;
    if (n === null && nullable.includes(key)) { result[key] = null; continue; }
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("invalid_response");
    result[key] = n;
  }
  return result;
}
function labels(source: Record<string, unknown>, result: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "string" || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid_response");
    result[key] = value;
  }
  return result;
}
function rows(value: unknown, project: (row: Record<string, unknown>) => Record<string, unknown>) {
  if (!Array.isArray(value)) throw new Error("invalid_response");
  return value.map(row => project(object(row)));
}
const counts = ["requests", "measuredRequests", "reportedRequests", "estimatedRequests", "totalTokens"];
const rates = ["averageTtftMs", "endToEndTokensPerSecond", "decodeTokensPerSecond"];

export function projectRemoteUsageDetails(body: Record<string, unknown>): Record<string, unknown> | undefined {
  // Older summary-only daemons can still provide totals; never synthesize missing charts.
  if (body.days === undefined) return undefined;
  const summary = numbers(body.summary, [...counts, "unreportedRequests", "unsupportedRequests", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "coverageRatio"],
    ["cacheReadInputTokens", "cacheCreationInputTokens", "estimatedCostUsd", "pricedRequests", "unpricedRequests", "unmeteredRequests"]);
  const report: Record<string, unknown> = {
    ...numbers(body, ["generatedAt"], ["truncatedPrefixBytes", "entriesDropped"], ["since", "snapshotWindowStart", "snapshotWindowEnd"]),
    range: body.range, surface: body.surface, summary,
    days: rows(body.days, row => {
      const day = labels(row, numbers(row, ["requests", "measuredRequests", "reportedRequests", "totalTokens"]), ["date"]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.date)) || !Number.isFinite(Date.parse(String(day.date)))) throw new Error("invalid_response");
      day.models = rows(row.models, model => labels(model, numbers(model, ["requests", "totalTokens"]), ["model", "provider"]));
      return day;
    }),
    models: rows(body.models, row => {
      const model = labels(row, numbers(row, [...counts, "inputTokens", "outputTokens", "shareRatio"], ["modelCallMs"], rates), ["model", "provider"]);
      if (row.resolvedModel !== undefined) labels(row, model, ["resolvedModel"]);
      return model;
    }),
    providers: rows(body.providers, row => labels(row, numbers(row, [...counts, "shareRatio"]), ["provider"])),
  };
  for (const key of ["historyTruncated", "entriesTruncated", "usageIncomplete", "customWindow"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new Error("invalid_response");
    report[key] = body[key];
  }
  if (body.usageIncompleteReason === "oversized_rows") report.usageIncompleteReason = body.usageIncompleteReason;
  if (body.until !== undefined) Object.assign(report, numbers(body, ["until"]));
  if (body.latency !== undefined) report.latency = numbers(body.latency, [], ["modelCallMs", "apiActiveMs", "activeTurns", "completedTurns"], ["activeWallMs", ...rates]);
  if (body.effortGroups !== undefined) report.effortGroups = rows(body.effortGroups, row => {
    const group = labels(row, numbers(row, ["requests", "requestShare", "modelCallMs", "inputTokens", "outputTokens"], [], rates), ["provider", "model", "speedMode", "requestedEffort", "effectiveEffort"]);
    if (!["fast", "standard", "downgraded", "unknown"].includes(String(group.speedMode))) throw new Error("invalid_response");
    return group;
  });
  return report;
}
