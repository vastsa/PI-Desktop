import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import(
  "../electron/main/runtime/provider-catalog.ts"
);
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });
const { resolveAutoCollapseSettledGroups, resolveAutoCollapseThinking } = await import(
  "../src/lib/transcript-folding.ts"
);
const { SETTINGS_NAV } = await import("../src/lib/settings-search.ts");

const ROWS = new URL("../src/components/settings/TranscriptFoldingRows.tsx", import.meta.url);
const PAGE = new URL(
  "../src/features/settings/pages/ConversationSettings.tsx",
  import.meta.url,
);

function withWindow(run) {
  const previous = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("folding defaults are on; only an explicit false turns them off", () => {
  for (const settings of [
    undefined,
    {},
    { showThinking: true },
    { autoCollapseThinking: true },
    { autoCollapseSettledGroups: true },
  ]) {
    assert.equal(resolveAutoCollapseThinking(settings), true);
    assert.equal(resolveAutoCollapseSettledGroups(settings), true);
  }
  assert.equal(resolveAutoCollapseThinking({ autoCollapseThinking: false }), false);
  assert.equal(resolveAutoCollapseSettledGroups({ autoCollapseSettledGroups: false }), false);
});

test("both settings boundaries default to on and keep an explicit false", () => {
  withWindow(() => {
    for (const stored of [
      {},
      { autoCollapseThinking: false },
      { autoCollapseSettledGroups: false },
      { autoCollapseThinking: false, autoCollapseSettledGroups: false },
    ]) {
      const received = structuredClone(main.normalizeSettings(stored));
      const displayed = renderer.normalizeSettings(received);
      assert.equal(displayed.autoCollapseThinking, stored.autoCollapseThinking !== false);
      assert.equal(
        displayed.autoCollapseSettledGroups,
        stored.autoCollapseSettledGroups !== false,
      );
      const persisted = main.validateSettingsWrite(
        structuredClone(renderer.validateSettingsWrite(displayed)),
      );
      assert.equal(persisted.autoCollapseThinking, stored.autoCollapseThinking !== false);
      assert.equal(
        persisted.autoCollapseSettledGroups,
        stored.autoCollapseSettledGroups !== false,
      );
    }
  });
});

test("non-boolean folding writes are rejected at both boundaries", () => {
  for (const field of ["autoCollapseThinking", "autoCollapseSettledGroups"]) {
    const settings = { theme: "light", [field]: "off" };
    assert.throws(
      () => renderer.validateSettingsWrite(settings),
      new RegExp(`${field} is invalid`),
      `the renderer must reject a non-boolean ${field}`,
    );
    assert.throws(
      () => main.validateSettingsWrite(settings),
      new RegExp(`${field} is invalid`),
      `the main process must reject a non-boolean ${field}`,
    );
  }
  assert.equal(typeof IPC, "object");
});

test("the two switches are sub-rows of the settings that gate them", async () => {
  const [rows, page] = await Promise.all([
    readFile(ROWS, "utf8"),
    readFile(PAGE, "utf8"),
  ]);
  // Hidden, never rewritten: the row bails out of rendering, so the stored value
  // survives turning `Show thinking` off or switching to the flat layout.
  assert.match(rows, /if \(!resolveShowThinking\(settings\)\) return null;/);
  assert.match(rows, /if \(resolveTranscriptDisplayMode\(settings\) === "flat"\) return null;/);
  assert.match(rows, /<SettingsRow\s*\n\s*nested/);
  assert.equal(
    rows.match(/saveSettings\(/g)?.length,
    2,
    "only the two toggles write, so hiding a row can never persist a default",
  );
  const showThinkingAt = page.indexOf("<ShowThinkingRow");
  const thinkingAt = page.indexOf("<AutoCollapseThinkingRow");
  assert.ok(showThinkingAt >= 0 && thinkingAt > showThinkingAt);
  const modeAt = page.indexOf("<TranscriptDisplayModeRow");
  const groupsAt = page.indexOf("<AutoCollapseSettledGroupsRow");
  assert.ok(modeAt >= 0 && groupsAt > modeAt);
});

test("both switches are searchable inside the Conversation destination", () => {
  const chat = SETTINGS_NAV.find((entry) => entry.id === "chat");
  assert.ok(chat);
  for (const key of [
    "settings.autoCollapseThinking",
    "settings.autoCollapseThinkingDesc",
    "settings.autoCollapseSettledGroups",
    "settings.autoCollapseSettledGroupsDesc",
  ]) {
    assert.ok(chat.keywordKeys.includes(key), `${key} is not indexed`);
  }
});
