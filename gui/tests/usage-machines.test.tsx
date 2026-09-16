import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Usage from "../src/pages/Usage";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;
let container: HTMLElement;
let apiBase: string;
let sequence = 0;
type RequestGate = { url: string; resolve: (response: Response) => void };
let requests: RequestGate[];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  testWindow.localStorage.setItem("ocx-lang", "en");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    ResizeObserver: { configurable: true, value: testWindow.ResizeObserver },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  // The page also has a held memory cache: each test gets a distinct report identity.
  apiBase = `http://usage-machines-${++sequence}`;
  requests = [];
  globalThis.fetch = ((input: RequestInfo | URL) => new Promise<Response>(resolve => {
    requests.push({ url: String(input), resolve });
  })) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(connected = false) {
  const previousRequests = requests.length;
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Usage apiBase={apiBase} connected={connected} apiKeyId={connected ? "machine/key + one" : undefined} /></LanguageProvider>);
  });
  expect(requests).toHaveLength(previousRequests + 2);
}

function report(gate: RequestGate, marker: string, date = "2020-09-15") {
  const query = new URL(gate.url).searchParams;
  const custom = query.has("since");
  return {
    range: query.get("range"), surface: query.get("surface"),
    since: custom ? Number(query.get("since")) : null,
    ...(custom ? { customWindow: true, until: Number(query.get("until")) } : {}),
    generatedAt: Date.now(),
    summary: {
      requests: 1, measuredRequests: 1, reportedRequests: 1, unreportedRequests: 0,
      unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 10, outputTokens: 20,
      cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 30, coverageRatio: 1,
    },
    days: [{ date, requests: 1, measuredRequests: 1, reportedRequests: 1, totalTokens: 30, models: [] }],
    models: [{ model: marker, provider: "openai", requests: 1, measuredRequests: 1, reportedRequests: 1,
      estimatedRequests: 0, totalTokens: 30, inputTokens: 10, outputTokens: 20, shareRatio: 1 }],
    providers: [], historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0,
  };
}

const remotes = [
  { id: "all", name: "Devbox one", usage: { summary: { requests: 12, inputTokens: 10, outputTokens: 20, cachedInputTokens: 0, totalTokens: 30 } } },
  { id: "local", name: "Devbox two", error: "unavailable" },
];
async function settle() {
  await act(async () => {
    for (const gate of requests) gate.resolve(Response.json(gate.url.includes("/remotes?") ? { remotes } : report(gate, "local-only-model")));
  });
}
async function options() {
  await act(async () => { container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Machine"]')!.click(); });
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}
async function select(name: string) {
  const items = await options();
  await act(async () => { items.find(item => item.textContent === name)!.click(); });
}

test("All defaults first; machine reports stay separate and reserved remote IDs do not collide", async () => {
  await mount();
  await settle();
  const items = await options();
  expect(items.map(item => item.textContent)).toEqual(["All", "Mac", "Devbox one", "Devbox two"]);
  expect(items[0].getAttribute("aria-selected")).toBe("true");
  await act(async () => { items[0].click(); });
  expect(container.querySelector('section[aria-label="Mac"]')?.textContent).toContain("local-only-model");
  expect(container.querySelector('section[aria-label="Devbox one"]')?.textContent).toContain("12");
  await select("Mac");
  expect(container.textContent).toContain("local-only-model");
  expect(container.querySelector('section[aria-label="Devbox one"]')).toBeNull();
  expect(document.querySelector(".toast-notice")).toBeNull();
  await select("Devbox one");
  expect(container.textContent).not.toContain("local-only-model");
  expect(container.querySelector('section[aria-label="Mac"]')).toBeNull();
  expect(container.querySelector('section[aria-label="Devbox two"]')).toBeNull();
  expect(container.querySelector('section[aria-label="Devbox one"]')?.textContent).toContain("Connected");
  expect(document.querySelector(".toast-notice")).toBeNull();
  await select("Devbox two");
  expect(container.querySelector(".stat")).toBeNull();
  expect(container.textContent).not.toContain("local-only-model");
  expect(container.querySelector('section[aria-label="Devbox two"]')?.textContent).toContain("Could not reach this remote proxy");
});

test("roster survives new ranges and collector failures without showing previous-window totals", async () => {
  await mount();
  await settle();
  await select("Devbox one");
  await act(async () => { container.querySelector<HTMLButtonElement>('button.usage-segmented-btn[aria-label="7d"]')!.click(); });
  expect(container.querySelector(".stat")).toBeNull();
  const items = await options();
  expect(items.map(item => item.textContent)).toEqual(["All", "Mac", "Devbox one", "Devbox two"]);
  expect(items[2].getAttribute("aria-selected")).toBe("true");
  await act(async () => { items[2].click(); });
  const remoteGate = requests.find(gate => gate.url.includes("/remotes?range=7d"))!;
  expect(remoteGate).toBeTruthy();
  await act(async () => { remoteGate.resolve(new Response("", { status: 503 })); });
  expect(container.querySelector(".stat")).toBeNull();
  expect(container.textContent).toContain("Remote usage is unavailable");
  await select("Mac");
  const localGate = requests.find(gate => !gate.url.includes("/remotes?") && gate.url.includes("range=7d"))!;
  await act(async () => { localGate.resolve(Response.json(report(localGate, "local-still-works"))); });
  expect(container.textContent).toContain("local-still-works");
  expect(container.textContent).not.toContain("Remote usage is unavailable");
});

test("changing API hosts retires the prior machine roster and selection", async () => {
  await mount();
  await settle();
  await select("Devbox one");
  await act(async () => { root!.render(<LanguageProvider><Usage apiBase="http://another-host" /></LanguageProvider>); });
  const items = await options();
  expect(items.map(item => item.textContent)).toEqual(["All", "Mac"]);
  expect(items[0].getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector(".stat")).toBeNull();
});
