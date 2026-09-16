import type { UsageReadMetadata } from "./usage-summary-resource";
type Range = "all" | "30d" | "7d" | "today";
type UsageSurface = "all" | "codex" | "claude" | "grok";

export interface UsageSummaryTotals {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  estimatedCostUsd?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
  unmeteredRequests?: number;
}

export interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  modelCallMs?: number;
  averageTtftMs?: number | null;
  endToEndTokensPerSecond?: number | null;
  decodeTokensPerSecond?: number | null;
  shareRatio: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

export interface UsageLatency {
  modelCallMs: number | null;
  apiActiveMs: number | null;
  activeWallMs: number | null;
  activeTurns: number | null;
  completedTurns: number | null;
  averageTtftMs: number | null;
  endToEndTokensPerSecond: number | null;
  decodeTokensPerSecond: number | null;
}

export interface UsageEffortGroup {
  provider: string;
  model: string;
  speedMode: "fast" | "standard" | "downgraded" | "unknown";
  requestedEffort: string;
  effectiveEffort: string;
  requests: number;
  requestShare: number;
  modelCallMs: number;
  inputTokens: number;
  outputTokens: number;
  averageTtftMs: number | null;
  endToEndTokensPerSecond: number | null;
  decodeTokensPerSecond: number | null;
}

export interface UsageResponse extends UsageReadMetadata {
  range: Range;
  surface: UsageSurface;
  since: number | null;
  until?: number;
  customWindow?: boolean;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
  // Optional because a dashboard can talk to a proxy that predates latency analytics.
  latency?: UsageLatency;
  effortGroups?: UsageEffortGroup[];
  // Bounds of the rows the bounded reader loaded, before any range or surface filtering.
  // Describes the read, not the query, and is never a completeness claim (#1497).
  // Optional because a dashboard can talk to a proxy that predates these fields.
  snapshotWindowStart?: number | null;
  snapshotWindowEnd?: number | null;
  error?: string;
}
