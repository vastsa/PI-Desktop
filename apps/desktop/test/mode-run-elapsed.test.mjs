import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "pi-mode-elapsed-"));
after(() => rm(temp, { recursive: true, force: true }));
const entry = join(temp, "elapsed.cjs");
await build({
  stdin: {
    contents: `
      import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { createInstance } from "i18next";
      import { I18nextProvider } from "react-i18next";
      import { ModeRunStatusPanel } from "./src/features/modes/ModeRunStatusBar";
      import { GoalBudgetSettingsRow } from "./src/features/modes/GoalBudgetSettingsRow";
      export { modeRunElapsedMs, formatModeRunElapsed } from "./src/features/modes/mode-run-elapsed";
      export { default as EN_TRANSLATION } from "../../packages/i18n/src/locales/en/index";
      export { default as ZH_TRANSLATION } from "../../packages/i18n/src/locales/zh-CN/index";
      export async function renderPanel(run, language, translation) {
        const i18n = createInstance();
        await i18n.init({ lng: language, resources: { [language]: { translation } } });
        return renderToStaticMarkup(createElement(I18nextProvider, { i18n },
          createElement(ModeRunStatusPanel, { run })));
      }
      export async function renderBudget(translation) {
        const i18n = createInstance();
        await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation } } });
        return renderToStaticMarkup(createElement(I18nextProvider, { i18n },
          createElement(GoalBudgetSettingsRow, { settings: {}, saveSettings: async () => {} })));
      }
    `,
    resolveDir: join(root, "apps/desktop"),
    loader: "tsx",
  },
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
  loader: { ".css": "empty" },
  alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts") },
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const { modeRunElapsedMs, formatModeRunElapsed, renderPanel, renderBudget, EN_TRANSLATION, ZH_TRANSLATION } = require(entry);
const EN_UNITS = { day: "d", hour: "h", minute: "m", second: "s" };
const ZH_UNITS = { day: "天", hour: "小时", minute: "分", second: "秒" };
const translation = (units) => ({
  settings: { modeGoal: "Goal", goalBudgetTurns: "轮数", goalBudgetTokens: "令牌" },
  modes: { run: {
    rounds: "Rounds {{completed}}/{{max}}",
    elapsed: EN_TRANSLATION.modes.run.elapsed,
    elapsedDayUnit: units.day,
    elapsedHourUnit: units.hour,
    elapsedMinuteUnit: units.minute,
    elapsedSecondUnit: units.second,
  } },
});
const RUN = {
  id: "run-1", sessionId: "session-1", modeId: "goal", snapshotHash: "hash",
  input: "finish", stageId: "work", state: "paused", revision: 2,
  roundsCompleted: 2, tokensUsed: 0, maxTurns: 20, maxTokens: null, artifactPaths: {},
  createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z",
};

test("elapsed formatting uses exactly one ASCII space between each number and unit", () => {
  const cases = [
    [0, "0 s"], [999, "0 s"], [1000, "1 s"], [59_999, "59 s"],
    [60_000, "1 m"], [61_000, "1 m 1 s"], [3_600_000, "1 h"],
    [3_601_000, "1 h 1 s"], [3_660_000, "1 h 1 m"], [86_400_000, "1 d"],
    [90_061_000, "1 d 1 h 1 m 1 s"], [172_801_000, "2 d 1 s"],
    [1000 * (1234 * 86_400 + 5 * 3600 + 6), "1234 d 5 h 6 s"],
  ];
  for (const [ms, expected] of cases) {
    const actual = formatModeRunElapsed(ms, EN_UNITS);
    assert.equal(actual, expected);
    assert.match(actual, /^\d+ [dhms](?: \d+ [dhms])*$/);
  }
});

test("formatting rejects negative and nonfinite durations", () => {
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(formatModeRunElapsed(invalid, EN_UNITS), "0 s");
  }
});

test("only running time accumulates across pause, resume, revisions and a replacement run", () => {
  const active = { ...RUN, state: "running", elapsedMs: 12_000, activeSinceMs: 10_000 };
  assert.equal(modeRunElapsedMs(active, 15_000), 17_000);
  assert.equal(modeRunElapsedMs(active, 16_000), 18_000);
  for (const state of ["paused", "waiting", "budget_exhausted", "finished", "stopped"]) {
    assert.equal(modeRunElapsedMs({ ...active, state, elapsedMs: 18_000 }, 60_000), 18_000, state);
  }
  const resumed = { ...active, revision: 4, elapsedMs: 18_000, activeSinceMs: 70_000 };
  assert.equal(modeRunElapsedMs(resumed, 72_000), 20_000);
  assert.equal(modeRunElapsedMs({ ...RUN, id: "run-2", state: "running" }, 90_000), 0);
});

test("legacy runs ignore createdAt, and invalid or backward clocks cannot add time", () => {
  for (const state of ["running", "paused", "waiting"]) {
    assert.equal(modeRunElapsedMs({ ...RUN, state }, Date.UTC(2026, 10, 7)), 0);
  }
  const active = { state: "running", elapsedMs: 4000, activeSinceMs: 10_000 };
  assert.equal(modeRunElapsedMs(active, 9000), 4000);
  assert.equal(modeRunElapsedMs(active, 10_000), 4000);
  for (const invalid of [undefined, NaN, Infinity, -Infinity]) {
    assert.equal(modeRunElapsedMs({ ...active, activeSinceMs: invalid }, 15_000), 4000);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(modeRunElapsedMs(active, invalid), 4000);
    assert.equal(modeRunElapsedMs({ ...active, elapsedMs: invalid }, 15_000), 5000);
  }
  assert.equal(modeRunElapsedMs({ ...active, elapsedMs: -500 }, 15_000), 5000);
  assert.equal(modeRunElapsedMs({ state: "running", activeSinceMs: 0 }, 5000), 5000);
  assert.ok(Number.isFinite(modeRunElapsedMs({
    state: "running", elapsedMs: Number.MAX_VALUE, activeSinceMs: -Number.MAX_VALUE,
  }, Number.MAX_VALUE)));
});

test("the real status panel renders spaced Latin units in both languages immediately after rounds", async (t) => {
  t.mock.method(Date, "now", () => 90_061_000);
  const html = await renderPanel({ ...RUN, state: "running", elapsedMs: 0, activeSinceMs: 0 }, "en", translation(EN_UNITS));
  assert.match(html, /class="mode-run-rounds">Rounds 2\/20<\/span><span class="mode-run-elapsed"/);
  assert.match(html, /title="Elapsed 1 d 1 h 1 m 1 s" aria-label="Elapsed 1 d 1 h 1 m 1 s">1 d 1 h 1 m 1 s<\/span>/);
  assert.ok(html.indexOf("mode-run-elapsed") < html.indexOf("mode-run-actions"));
  const legacy = await renderPanel({ ...RUN, state: "running", revision: 3 }, "en", translation(EN_UNITS));
  assert.match(legacy, /class="mode-run-elapsed"[^>]*>0 s<\/span>/);
  const chinese = await renderPanel({ ...RUN, revision: 4, elapsedMs: 86_401_000 }, "zh-CN", ZH_TRANSLATION);
  assert.match(chinese, /class="mode-run-elapsed"[^>]*>1 d 1 s<\/span>/);
  assert.ok(chinese.includes(ZH_TRANSLATION.modes.run.elapsed.replace("{{duration}}", "1 d 1 s")));
});

test("Resume, Pause, Edit and Remove are icon-only with localized accessible names; Stop stays text", async () => {
  for (const [language, catalog] of [["en", EN_TRANSLATION], ["zh-CN", ZH_TRANSLATION]]) {
    for (const state of ["paused", "running"]) {
      const html = await renderPanel({ ...RUN, state }, language, catalog);
      const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
      for (const action of [state === "running" ? "pause" : "resume", "edit", "remove"]) {
        const button = buttons.find(([, attrs]) => attrs.includes(`aria-label="${catalog.modes.run[action]}"`));
        assert.ok(button, `${language}/${state}: ${action} accessible name missing`);
        assert.match(button[2], /<svg\b[^>]*aria-hidden="true"/);
        assert.equal(button[2].replace(/<[^>]*>/g, "").trim(), "", `${action} must not show text`);
        assert.doesNotMatch(button[1], /\bdisabled/);
      }
      assert.ok(buttons.some(([, , body]) => body === catalog.modes.run.stop), "Stop remains a text action");
    }
  }
});

test("a reported blocker renders the existing Resume icon without Pause or approval actions", async () => {
  const html = await renderPanel({ ...RUN, state: "waiting", waitReason: "blocked", lastError: "Approval is required" }, "en", EN_TRANSLATION);
  assert.match(html, /data-state="blocked"/);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const resume = buttons.find(([, attrs]) => attrs.includes(`aria-label="${EN_TRANSLATION.modes.run.resume}"`));
  assert.ok(resume);
  assert.match(resume[2], /<svg\b/);
  assert.ok(!buttons.some(([, attrs]) => attrs.includes(`aria-label="${EN_TRANSLATION.modes.run.pause}"`)));
});

test("Goal budget keeps two labeled shared inputs in the same control", async () => {
  const html = await renderBudget(translation(ZH_UNITS));
  assert.match(html, /class="settings-goal-budget"/);
  assert.equal((html.match(/class="settings-goal-budget-field"/g) ?? []).length, 2);
  assert.equal((html.match(/class="field-input settings-goal-budget-input"/g) ?? []).length, 2);
  assert.match(html, /class="settings-goal-budget-label">轮数<\/span><input/);
  assert.match(html, /class="settings-goal-budget-label">令牌<\/span><input/);
});

test("Goal layout rules beat generic input widths and constrain wrapping metadata", async () => {
  const css = await readFile(join(root, "apps/desktop/src/styles/modes.css"), "utf8");
  const rules = new Map([...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [match[1].trim(), match[2]]));
  const input = rules.get(".settings-goal-budget .settings-goal-budget-input.field-input");
  assert.ok(input, "Goal input specificity must exceed .settings-row-control .field-input");
  assert.match(input, /width:\s*96px/);
  assert.match(input, /min-width:\s*0/);
  assert.match(rules.get(".settings-goal-budget"), /flex-wrap:\s*nowrap/);
  assert.match(rules.get(".settings-goal-budget-label"), /white-space:\s*nowrap/);
  assert.match(rules.get(".settings-row-control:has(> .settings-goal-budget)"), /max-width:\s*100%/);
  assert.match(rules.get(".mode-run-actions"), /max-width:\s*100%/);
  assert.match(rules.get(".mode-run-elapsed"), /overflow-wrap:\s*anywhere/);
});
