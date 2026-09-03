import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderHealth from "../src/pages/ProviderHealth";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let container: HTMLElement;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/#models/health" });
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
  globalThis.fetch = originalFetch;
  container.remove();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

async function waitForText(text: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(container.textContent ?? "").includes(text)) {
    if (Date.now() >= deadline) throw new Error(`Missing text: ${text}`);
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  }
}

test("provider health shows configuration problems and checks enabled providers", async () => {
  const probed: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/providers") return Response.json([
      { name: "work-azure", adapter: "openai-responses", baseUrl: "https://work.example/v1", hasApiKey: true },
      { name: "litellm", adapter: "openai-responses", baseUrl: "http://127.0.0.1:4000/v1", hasApiKey: true, coolingKeyCount: 1, credentialDisabled: true },
      { name: "off", adapter: "openai-chat", baseUrl: "https://off.example/v1", hasApiKey: true, disabled: true },
      { name: "missing", adapter: "openai-chat", baseUrl: "https://missing.example/v1", hasApiKey: false },
      { name: "expired", adapter: "anthropic", baseUrl: "https://api.example/v1", authMode: "oauth", oauthLoggedIn: false, activeNeedsReauth: true },
      { name: "cooled", adapter: "anthropic", baseUrl: "https://api.example/v1", authMode: "oauth", oauthLoggedIn: true, activeOAuthHealth: { status: "cooldown", reason: "rate_limit", until: new Date(Date.now() + 60_000).toISOString() } },
    ]);
    if (url.pathname === "/api/providers/test" && init?.method === "POST") {
      const name = url.searchParams.get("name")!;
      probed.push(name);
      if (name === "work-azure") return Response.json({ ok: true, latencyMs: 23, message: "Connected — 2 models available." });
      return Response.json({ ok: false, latencyMs: 7, error: "Connection failed" });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ProviderHealth apiBase="http://localhost" active providers={[]} /></LanguageProvider>);
  });
  await waitForText("Work Azure");

  expect(container.querySelector('[data-provider-health-row="litellm"]')?.textContent).toContain("Upstream API key is disabled");
  expect(container.querySelector('[data-provider-health-row="off"]')?.textContent).toContain("Disabled");
  expect(container.querySelector('[data-provider-health-row="missing"]')?.textContent).toContain("Needs setup");
  expect(container.querySelector('[data-provider-health-row="expired"]')?.textContent).toContain("Reauthentication required");
  expect(container.querySelector('[data-provider-health-row="cooled"]')?.textContent).toContain("Rate limited");

  await act(async () => {
    (container.querySelector("[data-provider-health-check-all]") as HTMLButtonElement).click();
  });
  await waitForText("Connected — 2 models available.");
  expect(container.querySelector('[data-provider-health-row="work-azure"]')?.textContent).toContain("23 ms");
  expect(probed.sort()).toEqual(["cooled", "expired", "litellm", "missing", "work-azure"]);
});
