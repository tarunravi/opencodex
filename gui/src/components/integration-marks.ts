/**
 * The mark for every row the Integrations page can show, and the set of assets
 * that must be drawn as a themed mask rather than an image.
 *
 * Why this is not just `CLIENT_MARKS`: the Integrations page reaches four rows
 * that are not export clients at all -- Codex CLI routing, Claude Code, Claude
 * Desktop and the Grok fence. Those ids live in a different namespace that
 * happens to overlap on the string "claude", so one map keyed by
 * `OverviewClientId` is the only shape that can serve the page.
 *
 * `MASKED_MARKS` is keyed by ASSET PATH, deliberately, where
 * `MONOCHROME_CLIENT_MARKS` is keyed by client id. `kimi-color.svg` is reachable
 * both as a provider icon and as a client mark; a path-keyed set cannot mask it
 * on one surface and leave it unmasked on another, which is exactly the
 * inconsistency a second id-keyed set would invite.
 */
import { CLIENT_MARKS, MONOCHROME_CLIENT_MARKS, type ExportClientId } from "./apikeys-workspace/client-config-clients";
import type { OverviewClientId } from "../pages/integrations/overview-clients";

/**
 * The four rows with no export client behind them.
 *
 * Codex takes the OpenAI mark because Codex CLI ships no mark of its own and
 * OpenAI publishes it. Claude Desktop shares Claude's: they are one brand and
 * two surfaces, and inventing a distinct mark for the desktop app would imply a
 * distinction that does not exist.
 */
const NATIVE_MARKS: Record<Exclude<OverviewClientId, ExportClientId>, string> = {
  codex: "/provider-icons/openai.svg",
  claude: "/provider-icons/claude-color.svg",
  claudeDesktop: "/provider-icons/claude-color.svg",
  grok: "/provider-icons/grok.svg",
};

/**
 * Every Integrations row to its mark. Exhaustive over `OverviewClientId`, so a
 * client added to the page without an asset decision is a compile error rather
 * than a silent monogram.
 *
 * A value may still be null: that is the honest answer for a client whose
 * vendor publishes nothing usable, and `ClientMark` renders a monogram for it.
 * Today none are, which `integration-marks.test.ts` pins.
 */
export const INTEGRATION_MARKS: Record<OverviewClientId, string | null> = {
  ...NATIVE_MARKS,
  opencode: CLIENT_MARKS.opencode ?? null,
  pi: CLIENT_MARKS.pi ?? null,
  omp: CLIENT_MARKS.omp ?? null,
  hermes: CLIENT_MARKS.hermes ?? null,
  openclaw: CLIENT_MARKS.openclaw ?? null,
  kimi: CLIENT_MARKS.kimi ?? null,
  gajae: CLIENT_MARKS.gajae ?? null,
  dsh: CLIENT_MARKS.dsh ?? null,
  mcode: CLIENT_MARKS.mcode ?? null,
  zcode: CLIENT_MARKS.zcode ?? null,
  prime: CLIENT_MARKS.prime ?? null,
  aside: CLIENT_MARKS.aside ?? null,
};

/**
 * Assets whose artwork is one neutral ink, so the ink has to come from the theme.
 *
 * Derived from `MONOCHROME_CLIENT_MARKS` rather than restated, because two
 * hand-maintained lists of the same fact drift. Nothing is added on top of it,
 * and the two candidates that look like they belong here do not:
 *
 * - `openai.svg` is a single fill, but that fill is #10A37F -- OpenAI's brand
 *   green. Masking it repaints a trademark in the theme's text color, which is
 *   the same reason `dsh` stays an image despite being single-ink.
 * - `grok.svg` is #000000, a genuine neutral and a real masking candidate. It
 *   is xAI's published asset with a literal fill, and rewriting that file to
 *   `currentColor` is a change to someone else's mark rather than a rendering
 *   choice, so it stays an image here.
 */
export const MASKED_MARKS: ReadonlySet<string> = new Set(
  [...MONOCHROME_CLIENT_MARKS].map(clientId => CLIENT_MARKS[clientId]).filter((src): src is string => src !== undefined),
);

/** The mark for a row, or null when it has none. */
export function markFor(clientId: OverviewClientId): string | null {
  return INTEGRATION_MARKS[clientId];
}

