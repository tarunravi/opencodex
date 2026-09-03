import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { interpolate, type TFn } from "../src/i18n/shared";
import { DashboardProvidersSection } from "../src/pages/dashboard-providers-section";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

test("provider key status shows upstream disablement and temporary cooldown", async () => {
  let switched = 0;
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {},
    onLogout: () => {},
    onReauth: () => {},
    onSwitchAccount: () => {},
    onRemoveAccount: () => {},
    onAddApiKey: async () => true,
    onSwitchApiKey: () => { switched += 1; },
    onRemoveApiKey: () => {},
    onEditAlias: () => {},
  };
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={{ name: "litellm", adapter: "openai-responses", baseUrl: "https://litellm.example/v1", authMode: "key", hasApiKey: true }}
          apiBase=""
          credentialDisabled
          keys={[{ id: "safe-id", masked: "lite****cret", active: false, cooldownUntil: Date.now() + 60_000 }]}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });

  expect(container.textContent).toContain("upstream API key is disabled");
  expect(container.textContent).toContain("Rate limited until");
  const keyButton = container.querySelector<HTMLButtonElement>(".pwi-auth-row-main");
  expect(keyButton?.disabled).toBe(false);
  await act(async () => { keyButton?.click(); });
  expect(switched).toBe(1);
});

test("dashboard distinguishes disabled, cooling, ready, and unconfigured providers", async () => {
  const t: TFn = (key, vars) => interpolate(en[key], vars);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<DashboardProvidersSection t={t} providers={[
      { name: "off", adapter: "openai-chat", baseUrl: "https://off.example", hasApiKey: true, disabled: true },
      { name: "cool", adapter: "openai-chat", baseUrl: "https://cool.example", hasApiKey: true, coolingKeyCount: 2, nextKeyRecoveryAt: Date.now() + 60_000 },
      { name: "on", adapter: "openai-chat", baseUrl: "https://on.example", hasApiKey: true },
      { name: "empty", adapter: "openai-chat", baseUrl: "https://empty.example", hasApiKey: false },
      { name: "local", adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", hasApiKey: false },
    ]} />);
  });

  expect(container.textContent).toContain("Disabled");
  expect(container.textContent).toContain("2 keys cooling down");
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).toContain("Needs setup");
  expect(Array.from(container.querySelectorAll("tr")).find(row => row.textContent?.includes("Local"))?.textContent).toContain("Ready");
  expect(container.querySelector(".badge-amber")?.getAttribute("title")).toContain("2 keys cooling down until");
});
