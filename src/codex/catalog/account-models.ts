import type { OcxConfig } from "../../types";
import {
  codexAccountNamespaceEntries,
  codexAccountPickerEnabled,
  isMainCodexAccountTarget,
} from "../account-namespaces";
import type { RawEntry } from "./parsing";

/** Stable nonsemantic marker used to distinguish generated rows from provider-owned rows. */
export const CODEX_ACCOUNT_BOUND_CATALOG_KIND = "account-selector-v1";

/**
 * Public selectors whose configured account row still exists.
 *
 * Stale mappings stay in config so exact routing keeps failing closed, but they must not advertise
 * a deleted account. Credential health, pause, and reauthentication state intentionally do not
 * churn catalog identity. Selector keys have already passed config's nonempty, single-segment
 * namespace validation. Only those public keys leave this boundary; private account ids do not.
 */
export function visibleCodexAccountSelectors(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): string[] {
  if (!codexAccountPickerEnabled(config)) return [];
  const storedPoolAccounts = new Set(
    (config.codexAccounts ?? [])
      .filter(account => !account.isMain)
      .map(account => account.id),
  );
  return codexAccountNamespaceEntries(config)
    .filter(([, accountId]) =>
      isMainCodexAccountTarget(accountId) || storedPoolAccounts.has(accountId)
    )
    .map(([selector]) => selector);
}

function safeExplicitAccountAlias(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const alias = value.trim();
  return alias.length > 0 && alias.length <= 80 && !/[\x00-\x1f\x7f]/.test(alias)
    ? alias
    : undefined;
}

/**
 * Display-only labels for public account selectors.
 *
 * The routing slug always keeps the privacy-safe selector. A user-owned alias may replace that
 * selector in `display_name`, but email addresses and private account ids are never inferred as
 * labels. Main-account rows have no configurable alias and therefore keep their public selector.
 */
export function accountBoundNativeDisplayLabels(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces">,
): ReadonlyMap<string, string> {
  const aliasesByAccountId = new Map(
    (config.codexAccounts ?? []).flatMap(account => {
      if (account.isMain) return [];
      const alias = safeExplicitAccountAlias(account.alias);
      return alias === undefined ? [] : [[account.id, alias] as const];
    }),
  );
  return new Map(codexAccountNamespaceEntries(config).map(([selector, accountId]) => [
    selector,
    aliasesByAccountId.get(accountId) ?? selector,
  ]));
}

function nativePickerDisplayName(native: RawEntry): string {
  const rawModel = typeof native.display_name === "string"
    ? native.display_name.trim()
    : String(native.slug ?? "").trim();
  const gpt = /^gpt-(.+)$/i.exec(rawModel);
  const parts = (gpt?.[1] ?? rawModel)
    .split("-")
    .filter(Boolean)
    .map(part => /^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
  return gpt ? `GPT-${parts}` : parts;
}

export function accountBoundNativeDisplayName(
  selector: string,
  native: RawEntry,
  displayLabel = selector,
): string {
  const label = safeExplicitAccountAlias(displayLabel) ?? selector;
  return `${label} · ${nativePickerDisplayName(native)}`;
}

/** Identify current generated rows without changing Codex's semantic model fields. */
export function trustedAccountBoundNativeCatalogSlug(entry: RawEntry): string | undefined {
  if (entry.opencodex_catalog_kind !== CODEX_ACCOUNT_BOUND_CATALOG_KIND
    || typeof entry.slug !== "string") return undefined;
  const slash = entry.slug.indexOf("/");
  if (slash <= 0 || slash !== entry.slug.lastIndexOf("/") || slash === entry.slug.length - 1) {
    return undefined;
  }
  return entry.slug.slice(slash + 1);
}

export function accountBoundNativeModelSlugs(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
  nativeSlugs: Iterable<string>,
): string[] {
  const natives = [...nativeSlugs];
  return visibleCodexAccountSelectors(config)
    .flatMap(selector => natives.map(slug => `${selector}/${slug}`));
}
