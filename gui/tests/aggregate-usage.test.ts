import { expect, test } from "bun:test";
import { aggregateUsage } from "../src/aggregate-usage";
import type { UsageResponse } from "../src/usage-report";
function report(requests: number, tokens: number, measured: number): UsageResponse {
  const counters = { requests, measuredRequests: measured, reportedRequests: measured, estimatedRequests: 0, totalTokens: tokens };
  return { range: "30d", surface: "all", since: 100, generatedAt: 200, summary: { ...counters,
    unreportedRequests: requests - measured, unsupportedRequests: 0, inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0,
    reasoningOutputTokens: 0, coverageRatio: measured / requests, estimatedCostUsd: 1 },
    days: [{ ...counters, date: "2026-09-16", models: [{ model: "m", provider: "p", requests, totalTokens: tokens }] }],
    models: [{ ...counters, model: "m", provider: "p", inputTokens: tokens, outputTokens: 0, shareRatio: 1, averageTtftMs: 42 }],
    providers: [{ ...counters, provider: "p", shareRatio: 1 }],
    latency: { modelCallMs: 100, apiActiveMs: 80, activeWallMs: 70, activeTurns: 1, completedTurns: 2, averageTtftMs: 42, endToEndTokensPerSecond: 10, decodeTokensPerSecond: 20 },
    effortGroups: [{ provider: "p", model: "m", speedMode: "fast", requestedEffort: "high", effectiveEffort: "high", requests, requestShare: 100, modelCallMs: 100, inputTokens: tokens, outputTokens: 0, averageTtftMs: 42, endToEndTokensPerSecond: 10, decodeTokensPerSecond: 20 }],
    historyTruncated: false, entriesTruncated: false, truncatedPrefixBytes: 0, entriesDropped: 0 };
}
test("All sums recorded counters and regrouped rows, recomputes ratios and leaves unreconstructible metrics unavailable", () => {
  const combined = aggregateUsage([report(10, 100, 5), report(30, 300, 30)])!;
  expect(combined.summary.requests).toBe(40);
  expect(combined.summary.totalTokens).toBe(400);
  expect(combined.summary.coverageRatio).toBe(35 / 40);
  expect(combined.summary.estimatedCostUsd).toBe(2);
  expect(combined.models).toHaveLength(1);
  expect(combined.models[0].shareRatio).toBe(1);
  expect(combined.models[0].averageTtftMs).toBeNull();
  expect(combined.providers[0].requests).toBe(40);
  expect(combined.days[0].models[0].totalTokens).toBe(400);
  expect(combined.effortGroups?.[0].requestShare).toBe(100);
  expect(combined.latency).toMatchObject({ modelCallMs: 200, activeTurns: 2, apiActiveMs: null, activeWallMs: null, averageTtftMs: null, endToEndTokensPerSecond: null });
});
test("missing optional metrics stay missing, distinct resolved models remain distinct, and single-source rates stay intact", () => {
  const a = report(2, 20, 1), b = report(3, 30, 2);
  delete b.summary.estimatedCostUsd;
  delete b.latency;
  b.models[0].resolvedModel = "different-model";
  b.historyTruncated = true;
  b.usageIncomplete = true;
  const combined = aggregateUsage([a, b])!;
  expect(combined.summary.estimatedCostUsd).toBeUndefined();
  expect(combined.latency).toBeUndefined();
  expect(combined.models).toHaveLength(2);
  expect(combined.models.map(row => row.shareRatio)).toEqual([0.4, 0.6]);
  expect(combined.historyTruncated).toBe(true);
  expect(combined.usageIncomplete).toBe(true);
  expect(aggregateUsage([a])?.latency?.averageTtftMs).toBe(42);
  expect(aggregateUsage([])).toBeNull();
});
