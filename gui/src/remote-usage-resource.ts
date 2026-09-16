import { useCallback, useState } from "react";
import { useDataSurface } from "./data-surface";

export type Range = "today" | "7d" | "30d" | "all";
export type Surface = "all" | "codex" | "claude" | "grok";
interface RemoteReport {
  id: string;
  name: string;
  usage?: { summary: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    estimatedCostUsd?: number;
  }; historyTruncated?: boolean; usageIncomplete?: boolean; timeZone?: string };
  error?: "unavailable" | "unauthorized" | "invalid_response" | "unsupported_window" | "timeout";
}
interface RemoteResponse { remotes: RemoteReport[]; error?: "invalid_config" }
export interface RemoteUsagePanelProps {
  apiBase: string;
  compact?: boolean;
  range?: Range;
  surface?: Surface;
  since?: number;
  until?: number;
}

export function useRemoteUsage({ apiBase, range = "all", surface = "all", since, until }: RemoteUsagePanelProps) {
  const [roster, setRoster] = useState<{ apiBase: string; machines: { id: string; name: string }[] }>({ apiBase, machines: [] });
  const load = useCallback(async (signal: AbortSignal): Promise<RemoteResponse> => {
    const query = new URLSearchParams({ range, surface });
    if (since !== undefined) query.set("since", String(since));
    if (until !== undefined) query.set("until", String(until));
    const response = await fetch(`${apiBase}/api/usage/remotes?${query}`, { signal });
    if (!response.ok) throw new Error("Remote usage unavailable");
    const data = await response.json() as RemoteResponse;
    if (!Array.isArray(data.remotes)) throw new Error("Invalid remote usage response");
    if (!data.error && !signal.aborted) setRoster({ apiBase, machines: data.remotes.map(({ id, name }) => ({ id, name })) });
    return data;
  }, [apiBase, range, surface, since, until]);
  const resource = useDataSurface(
    JSON.stringify(["remote-usage", apiBase, range, surface, since, until]),
    [apiBase, range, surface, since, until], load,
    { isEmpty: data => data.remotes.length === 0, pollMs: 60_000 },
  );
  const machines = resource.state.data && !resource.state.data.error ? resource.state.data.remotes : roster.apiBase === apiBase ? roster.machines : [];
  return { ...resource, machines };
}
