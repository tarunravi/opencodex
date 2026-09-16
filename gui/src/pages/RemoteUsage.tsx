import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { UsageResponse } from "../usage-report";
import { useI18n } from "../i18n/shared";
import { useRemoteUsage, type RemoteUsagePanelProps, type Range, type Surface } from "../remote-usage-resource";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { formatTokens } from "../format-tokens";
import { formatEstimatedUsdValue } from "../intl-formatters";
import { ToastNotice } from "../ui";


export function RemoteUsagePanel(props: RemoteUsagePanelProps) {
  const resource = useRemoteUsage(props);
  return <RemoteUsageResults resource={resource} range={props.range} compact={props.compact} />;
}

export function RemoteUsageResults({ resource, range, compact = false, machineId, renderUsage }: {
  resource: ReturnType<typeof useRemoteUsage>;
  range?: Range;
  compact?: boolean;
  machineId?: string;
  renderUsage?: (report: UsageResponse, name: string) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const { state } = resource;
  const remotes = (state.data?.remotes ?? []).filter(remote => machineId === undefined || remote.id === machineId);
  const unavailable = state.showError || !!state.data?.error;
  const failed = remotes.filter(remote => !!remote.error || !remote.usage);
  const failureKey = unavailable ? "collector" : failed.map(remote => remote.id).sort().join("|");
  const seenFailure = useRef("");
  const [toastKey, setToastKey] = useState("");
  useEffect(() => {
    if (state.refreshing) return;
    if (failureKey !== seenFailure.current) {
      seenFailure.current = failureKey;
      setToastKey(failureKey);
    }
  }, [failureKey, state.refreshing]);
  const warning = unavailable ? t("remoteUsage.unavailable") : t("remoteUsage.warning", { names: failed.map(remote => remote.name).join(", ") });
  const toast = toastKey && failureKey ? <ToastNotice tone="warn" dismissLabel={t("common.close")} onDismiss={() => setToastKey("")}>{warning}</ToastNotice> : null;
  if (compact) return <>{failureKey && <p className="notice notice-warn">{warning}</p>}{toast}</>;
  return (
    <section className="panel" aria-labelledby={titleId} aria-busy={state.refreshing}>
      <div className="page-head">
        <h3 id={titleId}>{t("remoteUsage.title")}</h3>
        <button type="button" className="btn btn-ghost btn-sm" disabled={state.refreshing} onClick={() => resource.refresh()}>
          {t("remoteUsage.refresh")}
        </button>
      </div>
      <p className="muted">{t("remoteUsage.subtitle")}</p>
      {state.showSkeleton && <DataSurfaceSkeleton label={t("common.loading")} rows={2} />}
      {unavailable && <p className="notice notice-warn">{t("remoteUsage.unavailable")}</p>}
      {state.showError && remotes.length > 0 && <p className="muted">{t("remoteUsage.stale")}</p>}
      {!state.showSkeleton && !unavailable && remotes.length === 0 && <p className="muted">{t("remoteUsage.empty")}</p>}
      {remotes.map(remote => (
        <section className="panel" key={remote.id} aria-label={remote.name}>
          <h4>{remote.name}</h4>
          {remote.error || !remote.usage ? <p className="notice notice-warn">{t(remote.error === "unsupported_window" ? "remoteUsage.unsupportedWindow" : remote.error === "unauthorized" ? "remoteUsage.unauthorized" : remote.error === "invalid_response" ? "remoteUsage.invalidResponse" : "remoteUsage.offline")}</p> : <>
            {!unavailable && <p className="muted">{t("remoteUsage.online")}</p>}
            {(!renderUsage || !remote.usage.details) && (remote.usage.historyTruncated || remote.usage.usageIncomplete) && <p className="notice notice-warn">{t("remoteUsage.partial")}</p>}
            {range === "today" && remote.usage.timeZone && <p className="muted">{t("remoteUsage.timeZone", { zone: remote.usage.timeZone })}</p>}
            {renderUsage && remote.usage.details ? renderUsage(remote.usage.details, remote.name) : <>
            {renderUsage && <p className="muted">{t("remoteUsage.summaryOnly")}</p>}
            <div className="usage-cards usage-cards-3x2">
              {([
                ["usage.card.requests", remote.usage.summary.requests.toLocaleString(locale)],
                ["usage.card.totalTokens", formatTokens(remote.usage.summary.totalTokens, locale)],
                ["usage.col.inputTokens", formatTokens(remote.usage.summary.inputTokens, locale)],
                ["usage.col.outputTokens", formatTokens(remote.usage.summary.outputTokens, locale)],
                ["usage.card.cachedTokens", formatTokens(remote.usage.summary.cachedInputTokens, locale)],
              ] as const).map(([key, value]) => <div className="stat" key={key}><div className="muted">{t(key)}</div><div className="stat-value">{value}</div></div>)}
              {remote.usage.summary.estimatedCostUsd !== undefined && <div className="stat"><div className="muted">{t("usage.cost.total")}</div><div className="stat-value">{formatEstimatedUsdValue(remote.usage.summary.estimatedCostUsd, locale)}</div></div>}
            </div>
            </>}
          </>}
        </section>
      ))}
      {toast}
    </section>
  );
}

export default function RemoteUsage({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [range, setRange] = useState<Range>("all");
  const [surface, setSurface] = useState<Surface>("all");
  return <>
    <div className="page-head usage-head">
      <h2>{t("remoteUsage.title")}</h2>
      <div className="usage-segmented" role="group" aria-label={t("remoteUsage.range")}>
        {(["all", "30d", "7d", "today"] as const).map(value => <button key={value} type="button" className={`usage-segmented-btn${range === value ? " active" : ""}`} aria-pressed={range === value} onClick={() => setRange(value)}>{value === "today" ? t("remoteUsage.today") : t(`usage.range.${value}`)}</button>)}
      </div>
      <div className="usage-segmented" role="group" aria-label={t("logs.filter.surface.label")}>
        {(["all", "codex", "claude", "grok"] as const).map(value => <button key={value} type="button" className={`usage-segmented-btn${surface === value ? " active" : ""}`} aria-pressed={surface === value} onClick={() => setSurface(value)}>{t(`logs.filter.surface.${value}`)}</button>)}
      </div>
    </div>
    <RemoteUsagePanel apiBase={apiBase} range={range} surface={surface} />
  </>;
}
