import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import RemoteUsage, { RemoteUsagePanel } from "../src/pages/RemoteUsage";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let dom: Window;
let root: Root | undefined;
let container: HTMLElement;
const originalFetch = globalThis.fetch;
let requests: { url: string; resolve: (response: Response) => void }[];
beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  clearClientResourceStoresForTests();
  dom = new Window({ url: "http://localhost/" });
  dom.localStorage.setItem("ocx-lang", "en");
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
  requests = [];
  globalThis.fetch = ((input: RequestInfo | URL) => new Promise<Response>(resolve => requests.push({ url: String(input), resolve }))) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  dom.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});
const online = { id: "devbox", name: "Devbox one", usage: { summary: { requests: 12, inputTokens: 31, outputTokens: 47, cachedInputTokens: 7, totalTokens: 78, estimatedCostUsd: 0.123 } } };
async function mount(page = false, compact = false) {
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider>{page ? <RemoteUsage apiBase="" /> : <><p>Local usage: 999</p><RemoteUsagePanel compact={compact} apiBase="" /></>}</LanguageProvider>);
  });
}
async function respond(index: number, data: unknown, status = 200) {
  await act(async () => { requests[index].resolve(Response.json(data, { status })); });
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === label || button.getAttribute("aria-label") === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test("remote usage loads independently and displays each machine without combining local totals", async () => {
  await mount();
  expect(container.textContent).toContain("Local usage: 999");
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(requests[0].url).toBe("/api/usage/remotes?range=all&surface=all");
  await respond(0, { remotes: [online, { id: "offline", name: "Devbox two", error: "timeout" }] });
  const remote = container.querySelector('[aria-label="Devbox one"]')!;
  expect(remote.textContent).toContain("78");
  expect(remote.textContent).toContain("31");
  expect(remote.textContent).toContain("47");
  expect(remote.textContent).toContain("12");
  expect(container.querySelector('[aria-label="Devbox two"]')!.querySelector(".stat")).toBeNull();
  expect(container.textContent).toContain("Local usage: 999");
  expect(document.querySelector(".toast-notice")?.textContent).toContain("Devbox two");
});

test("dismissing an offline warning preserves machine status and repeated failures stay dismissed", async () => {
  await mount();
  const failed = { remotes: [{ id: "devbox", name: "Devbox one", error: "unavailable" }] };
  await respond(0, failed);
  await click("Close");
  expect(document.querySelector(".toast-notice")).toBeNull();
  expect(container.textContent).toContain("Could not reach this remote proxy.");
  await click("Refresh remote usage");
  await respond(1, failed);
  expect(document.querySelector(".toast-notice")).toBeNull();
  await click("Refresh remote usage");
  await respond(2, { remotes: [online] });
  await click("Refresh remote usage");
  await respond(3, failed);
  expect(document.querySelector(".toast-notice")).not.toBeNull();
});

test("collector failure leaves local usage visible and offers retry without false zeros", async () => {
  await mount();
  await respond(0, {}, 502);
  expect(container.textContent).toContain("Local usage: 999");
  expect(container.textContent).toContain("Remote usage is unavailable");
  expect(container.querySelector(".stat")).toBeNull();
  await click("Refresh remote usage");
  await respond(1, { remotes: [online] });
  expect(container.textContent).toContain("Devbox one");
  expect(document.querySelector(".toast-notice")).toBeNull();
});

test("filter changes request the new range and surface and replace the previous report", async () => {
  await mount(true);
  await respond(0, { remotes: [online] });
  await click("7d");
  expect(requests[1].url).toContain("range=7d&surface=all");
  expect(container.textContent).not.toContain("Devbox one");
  await respond(1, { remotes: [] });
  await click("Codex");
  expect(requests[2].url).toContain("range=7d&surface=codex");
  await respond(2, { remotes: [] });
  await act(async () => root!.render(<LanguageProvider><RemoteUsagePanel apiBase="" range="7d" surface="claude" since={100} until={200} /></LanguageProvider>));
  expect(requests[3].url).toContain("range=7d&surface=claude&since=100&until=200");
  await respond(3, { remotes: [] });
});

test("partial reports remain visibly incomplete and today identifies the remote clock", async () => {
  await mount(true);
  await respond(0, { remotes: [] });
  await click("Today (remote time)");
  expect(requests[1].url).toContain("range=today");
  await respond(1, { remotes: [{ ...online, usage: { ...online.usage, historyTruncated: true, timeZone: "Etc/UTC" } }] });
  expect(container.textContent).toContain("This remote report is incomplete");
  expect(container.textContent).toContain("Today uses the remote time zone: Etc/UTC.");
});


test("compact Usage-page status warns without duplicating remote counters", async () => {
  await mount(false, true);
  await respond(0, { remotes: [online, { id: "offline", name: "Devbox two", error: "unavailable" }] });
  expect(container.querySelector(".stat")).toBeNull();
  expect(container.textContent).toContain("Devbox two");
  expect(document.querySelector(".toast-notice")).not.toBeNull();
});
