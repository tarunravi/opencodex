import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useT } from "../i18n/shared";
import type { ConfiguredProviderSummary } from "../models-groups";
import { formatOAuthHealthLabel, type OAuthHealthView } from "../oauth-health-display";
import { formatProviderDisplayName } from "../provider-icons";
import { Notice } from "../ui";

export interface ProviderHealthProvider extends ConfiguredProviderSummary {
  adapter?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  hasHeaders?: boolean;
  keyOptional?: boolean;
  coolingKeyCount?: number;
  nextKeyRecoveryAt?: number;
  credentialDisabled?: boolean;
  oauthLoggedIn?: boolean;
  activeNeedsReauth?: boolean;
}

type ProbeResponse = {
  applicable?: boolean;
  ok?: boolean;
  latencyMs?: number;
  message?: string;
  error?: string;
};

type ProbeState =
  | { status: "checking" }
  | { status: "ok" | "failed" | "not-applicable"; latencyMs?: number; message?: string };

function hasLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function providerNeedsSetup(provider: ProviderHealthProvider): boolean {
  if (provider.authMode === "oauth" && provider.oauthLoggedIn === false) return true;
  return provider.keyOptional !== true
    && provider.authMode !== "oauth"
    && provider.authMode !== "forward"
    && provider.authMode !== "local"
    && !hasLoopbackBaseUrl(provider.baseUrl)
    && provider.hasApiKey !== true
    && provider.hasHeaders !== true;
}

function mergeProviders(
  initial: ProviderHealthProvider[],
  fetched: ProviderHealthProvider[],
): ProviderHealthProvider[] {
  const initialByName = new Map(initial.map(provider => [provider.name, provider]));
  return fetched.map(provider => ({
    ...initialByName.get(provider.name),
    ...provider,
  }));
}

export default function ProviderHealth({
  apiBase,
  active = true,
  providers,
}: {
  apiBase: string;
  active?: boolean;
  providers: ProviderHealthProvider[];
}) {
  const t = useT();
  const [fetched, setFetched] = useState<{ apiBase: string; rows: ProviderHealthProvider[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const probeControllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    if (!active) {
      for (const controller of probeControllers.current.values()) controller.abort();
      probeControllers.current.clear();
      return;
    }

    const controller = new AbortController();
    void fetch(`${apiBase}/api/providers`, { signal: controller.signal })
      .then(response => readJsonOrThrow<ProviderHealthProvider[]>(response))
      .then(fetched => {
      if (controller.signal.aborted || !Array.isArray(fetched)) return;
      setFetched({ apiBase, rows: fetched });
      setLoadFailed(false);
    }).catch(() => {
      if (!controller.signal.aborted) setLoadFailed(true);
    });

    return () => controller.abort();
  }, [active, apiBase]);

  useEffect(() => () => {
    for (const controller of probeControllers.current.values()) controller.abort();
    probeControllers.current.clear();
  }, []);

  const orderedRows = useMemo(() => {
    const rows = fetched?.apiBase === apiBase
      ? mergeProviders(providers, fetched.rows)
      : providers;
    return [...rows].sort((a, b) => formatProviderDisplayName(a.name, t).localeCompare(formatProviderDisplayName(b.name, t)));
  }, [apiBase, fetched, providers, t]);
  const checkableRows = useMemo(() => orderedRows.filter(provider => !provider.disabled), [orderedRows]);

  const checkProvider = useCallback(async (provider: ProviderHealthProvider) => {
    probeControllers.current.get(provider.name)?.abort();
    const controller = new AbortController();
    probeControllers.current.set(provider.name, controller);
    setProbes(current => ({ ...current, [provider.name]: { status: "checking" } }));

    try {
      const response = await fetch(`${apiBase}/api/providers/test?name=${encodeURIComponent(provider.name)}`, {
        method: "POST",
        signal: controller.signal,
      });
      const result = await readJsonOrThrow<ProbeResponse>(response, t("pws.connectionFailed"));
      if (!result) throw new Error(t("pws.connectionFailed"));
      if (controller.signal.aborted) return;
      const latencyMs = typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs)
        ? Math.max(0, Math.round(result.latencyMs))
        : undefined;
      setProbes(current => ({
        ...current,
        [provider.name]: result.applicable === false
          ? { status: "not-applicable", latencyMs }
          : result.ok === true
            ? { status: "ok", latencyMs, message: result.message }
            : { status: "failed", latencyMs, message: result.error },
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setProbes(current => ({
        ...current,
        [provider.name]: {
          status: "failed",
          message: error instanceof Error ? error.message : t("pws.connectionFailed"),
        },
      }));
    } finally {
      if (probeControllers.current.get(provider.name) === controller) {
        probeControllers.current.delete(provider.name);
      }
    }
  }, [apiBase, t]);

  const anyChecking = Object.values(probes).some(probe => probe.status === "checking");
  const checkAll = useCallback(async () => {
    let next = 0;
    const worker = async () => {
      while (next < checkableRows.length) {
        const provider = checkableRows[next++];
        if (provider) await checkProvider(provider);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, checkableRows.length) }, worker));
  }, [checkProvider, checkableRows]);

  const configurationBadge = (provider: ProviderHealthProvider) => {
    if (provider.disabled) return <span className="badge badge-muted">{t("prov.disabledBadge")}</span>;
    if (provider.activeOAuthHealth?.status && provider.activeOAuthHealth.status !== "healthy") {
      const label = formatOAuthHealthLabel(t, provider.activeOAuthHealth as OAuthHealthView);
      if (!label) return <span className="badge badge-amber">{t("pws.attentionRequired")}</span>;
      return (
        <span
          className="badge badge-amber"
          title={provider.activeOAuthHealth.status === "cooldown" && provider.activeOAuthHealth.until
            ? new Date(provider.activeOAuthHealth.until).toLocaleString()
            : undefined}
        >
          {label}
        </span>
      );
    }
    if (provider.activeNeedsReauth) return <span className="badge badge-amber">{t("pws.healthLabel.reauthRequired")}</span>;
    if (provider.credentialDisabled) return <span className="badge badge-amber">{t("pws.attention.keyDisabled")}</span>;
    if ((provider.coolingKeyCount ?? 0) > 0) {
      return (
        <span
          className="badge badge-amber"
          title={provider.nextKeyRecoveryAt
            ? t("dash.provider.keysCoolingDownUntil", { count: provider.coolingKeyCount ?? 0, until: new Date(provider.nextKeyRecoveryAt).toLocaleString() })
            : undefined}
        >
          {t("dash.provider.keysCoolingDown", { count: provider.coolingKeyCount ?? 0 })}
        </span>
      );
    }
    if (providerNeedsSetup(provider)) return <span className="badge badge-amber">{t("pws.status.needsSetup")}</span>;
    return <span className="badge badge-green">{t("models.health.configured")}</span>;
  };

  const probeLabel = (probe?: ProbeState) => {
    if (!probe) return t("time.notChecked");
    if (probe.status === "checking") return t("pws.testing");
    if (probe.status === "not-applicable") return t("pws.connectionNotApplicable");
    if (probe.status === "ok") return t("pws.connectionOk");
    return t("pws.connectionFailed");
  };

  return (
    <section className="panel" aria-labelledby="provider-health-title">
      <h2 id="provider-health-title" className="sr-only">{t("models.tab.health")}</h2>
      <div className="models-health-toolbar">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-provider-health-check-all
          disabled={checkableRows.length === 0 || anyChecking}
          onClick={() => void checkAll()}
        >
          {anyChecking ? t("pws.testing") : t("models.health.checkAll")}
        </button>
      </div>

      {loadFailed && <Notice tone="err">{t("prov.loadConfigFail")}</Notice>}
      {orderedRows.length === 0 ? (
        <p className="muted">{t("pws.noProvidersConfigured")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("dash.col.name")}</th>
                <th>{t("models.health.configuration")}</th>
                <th>{t("models.health.liveStatus")}</th>
                <th>{t("models.health.latency")}</th>
                <th><span className="sr-only">{t("pws.testConnection")}</span></th>
              </tr>
            </thead>
            <tbody>
              {orderedRows.map(provider => {
                const probe = probes[provider.name];
                const tone = probe?.status === "ok" ? "badge-green" : probe?.status === "failed" ? "badge-amber" : "badge-muted";
                return (
                  <tr key={provider.name} data-provider-health-row={provider.name}>
                    <td>
                      <span className="font-semibold">{formatProviderDisplayName(provider.name, t)}</span>
                      {provider.adapter && <div><code className="muted">{provider.adapter}</code></div>}
                    </td>
                    <td>{configurationBadge(provider)}</td>
                    <td>
                      <span className={`badge ${tone}`} role="status">{probeLabel(probe)}</span>
                      {probe && probe.status !== "checking" && probe.message && (
                        <div className="models-health-detail muted">{probe.message}</div>
                      )}
                    </td>
                    <td className="mono">{probe && probe.status !== "checking" && probe.latencyMs !== undefined ? `${probe.latencyMs} ms` : "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={provider.disabled || probe?.status === "checking"}
                        onClick={() => void checkProvider(provider)}
                      >
                        {probe?.status === "checking" ? t("pws.testing") : t("pws.testConnection")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
