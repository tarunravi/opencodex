import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INTEGRATION_MARKS, MASKED_MARKS } from "../src/components/integration-marks";
import { CLIENT_MARKS, MONOCHROME_CLIENT_MARKS } from "../src/components/apikeys-workspace/client-config-clients";
import { TABS } from "../src/pages/integrations/integration-tabs";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

function bodyOf(src: string): string {
  return readFileSync(join(PUBLIC_DIR, src.replace(/^\//, "")), "utf8");
}

function inksOf(body: string): Set<string> {
  const matches = body.match(/(?:fill|stop-color)\s*[:=]\s*"?#[0-9a-fA-F]{3,8}/g) ?? [];
  return new Set(matches.map(raw => raw.split(/[:=]/).pop()!.replace(/"/g, "").trim().toLowerCase()));
}

/*
 * The page renders a mark for every row it draws, so a row whose id is missing
 * from the map renders nothing where a logo should be. The map is a Record over
 * OverviewClientId, so the compiler catches an omission -- but only for ids that
 * type already knows. This asserts the values are real.
 */
test("every Integrations row has a mark that resolves to a committed file", () => {
  const broken = Object.entries(INTEGRATION_MARKS)
    .filter(([, src]) => src !== null && !existsSync(join(PUBLIC_DIR, src.replace(/^\//, ""))));
  expect(broken).toEqual([]);
});

/*
 * A null value is a legitimate answer -- it renders a monogram -- but none of the
 * current rows should be taking it. If one does, either an asset was dropped or a
 * client was added without a mark decision, and both look like a rendering bug
 * from the outside.
 */
test("no Integrations row falls back to a monogram today", () => {
  const monogram = Object.entries(INTEGRATION_MARKS)
    .filter(([, src]) => src === null)
    .map(([id]) => id);
  expect(monogram).toEqual([]);
});

/*
 * Masking paints the artwork with the theme's text color, discarding whatever
 * the file carries. Doing that to a multi-color mark flattens a brand palette
 * into one ink, and the result still renders and still looks deliberate, which is
 * why this needs a test rather than review attention.
 */
test("no multi-color asset is masked", () => {
  const flattened: string[] = [];
  for (const src of MASKED_MARKS) {
    const body = bodyOf(src);
    const gradient = /<(linearGradient|radialGradient)[\s>]/.test(body);
    const inks = inksOf(body);
    if (gradient || inks.size > 1) flattened.push(`${src}: ${inks.size} ink(s)${gradient ? " + gradient" : ""}`);
  }
  expect(flattened).toEqual([]);
});

/*
 * The inverse rule, and the one that cannot be derived from the file: a mark may
 * be a single ink and still not be a masking candidate, because that ink is the
 * brand. openai.svg is #10A37F and deepseek-harness.svg is #4d6bfe; masking
 * either repaints a trademark in the theme's text color. Pinned with their inks
 * so a vendor changing its asset shows up here rather than silently satisfying
 * the assertion.
 */
test("a single-ink asset whose ink is a brand color is not masked", () => {
  for (const [src, ink] of [
    ["/provider-icons/openai.svg", "#10a37f"],
    ["/provider-icons/deepseek-harness.svg", "#4d6bfe"],
  ] as const) {
    expect(MASKED_MARKS.has(src), `${src} must not be masked`).toBe(false);
    expect([...inksOf(bodyOf(src))], `${src} ink changed upstream`).toEqual([ink]);
  }
});

/*
 * MASKED_MARKS is derived from MONOCHROME_CLIENT_MARKS rather than restated, and
 * this is what makes that derivation observable: the two must describe the same
 * assets. A second hand-maintained list would drift, and the drift would be a
 * mark masked on one surface and not on another.
 */
test("the masked set is exactly the monochrome client marks", () => {
  const expected = [...MONOCHROME_CLIENT_MARKS].map(id => CLIENT_MARKS[id]).filter(Boolean).sort();
  expect([...MASKED_MARKS].sort()).toEqual(expected as string[]);
});

/*
 * The tab strip draws a mark per tab, and two tabs have no client behind them:
 * overview is the page and keys is a credential surface. Every OTHER tab must be
 * in the map, or its tab renders bare while its neighbours carry logos.
 */
test("every client tab has a mark", () => {
  const bare = TABS
    .filter(tab => tab.id !== "overview" && tab.id !== "keys")
    .filter(tab => !(tab.id in INTEGRATION_MARKS));
  expect(bare.map(tab => tab.id)).toEqual([]);
});

