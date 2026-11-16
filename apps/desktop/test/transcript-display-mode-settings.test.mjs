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

test("transcript display mode is searchable from the Conversation destination beside show thinking", () => {
  // Presentation rows live on Conversation since D684, indexed in the order
  // they render: Show thinking and its sub-row, then Transcript display and
  // its sub-row.
  const chat = SETTINGS_NAV.find((entry) => entry.id === "chat");
  assert.ok(chat, "Conversation settings entry is registered");
  const showThinkingAt = chat.keywordKeys.indexOf("settings.showThinking");
  assert.ok(showThinkingAt >= 0, "show thinking remains indexed");
  assert.deepEqual(
    chat.keywordKeys.slice(showThinkingAt, showThinkingAt + 6),
    [
      "settings.showThinking",
      "settings.showThinkingDesc",
      "settings.autoCollapseThinking",
      "settings.autoCollapseThinkingDesc",
      "settings.transcriptDisplayMode",
      "settings.transcriptDisplayModeDesc",
    ],
  );

  const titleHits = searchSettings("transcript display", t, {
    developerMode: false,
    includeDevelopmentOnly: false,
  }).filter((hit) => hit.tab === "chat");
  assert.ok(
    titleHits.some((hit) => hit.rowKey === "settings.transcriptDisplayMode"),
    "the transcript-display title is searchable",
  );

  const descriptionHits = searchSettings("assistant process", t, {
    developerMode: false,
    includeDevelopmentOnly: false,
  }).filter((hit) => hit.tab === "chat");
  assert.ok(
    descriptionHits.some(
      (hit) => hit.rowKey === "settings.transcriptDisplayModeDesc",
    ),
    "the transcript-display description is searchable",
  );
});
