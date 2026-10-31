import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { SETTINGS_NAV, searchSettings } = await import(
  "../src/lib/settings-search.ts"
);
const { en } = await import(
  "../../../packages/i18n/src/locales/en/index.ts"
);
const { flattenCatalog } = await import(
  "../../../packages/i18n/src/locale-info.ts"
);

const copy = flattenCatalog(en);
const t = (key) => copy[key] ?? key;

test("transcript display mode is searchable from the AI preferences beside show thinking", () => {
  const ai = SETTINGS_NAV.find((entry) => entry.id === "ai");
  assert.ok(ai, "AI settings entry is registered");
  const showThinkingAt = ai.keywordKeys.indexOf("settings.showThinking");
  assert.ok(showThinkingAt >= 0, "show thinking remains indexed");
  assert.deepEqual(
    ai.keywordKeys.slice(showThinkingAt, showThinkingAt + 4),
    [
      "settings.showThinking",
      "settings.showThinkingDesc",
      "settings.transcriptDisplayMode",
      "settings.transcriptDisplayModeDesc",
    ],
  );

  const titleHits = searchSettings("transcript display", t, {
    developerMode: false,
    includeDevelopmentOnly: false,
  }).filter((hit) => hit.tab === "ai");
  assert.ok(
    titleHits.some((hit) => hit.rowKey === "settings.transcriptDisplayMode"),
    "the transcript-display title is searchable",
  );

  const descriptionHits = searchSettings("assistant process", t, {
    developerMode: false,
    includeDevelopmentOnly: false,
  }).filter((hit) => hit.tab === "ai");
  assert.ok(
    descriptionHits.some(
      (hit) => hit.rowKey === "settings.transcriptDisplayModeDesc",
    ),
    "the transcript-display description is searchable",
  );
});
