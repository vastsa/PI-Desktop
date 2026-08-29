import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const NO_CORRECTION = [
  "spellCheck={false}",
  'autoCorrect="off"',
  'autoCapitalize="off"',
];

test("shared Input/Textarea primitives default text correction off", async () => {
  const src = await read("../src/components/ui.tsx");
  assert.match(
    src,
    /export function Input\(\{ className, spellCheck = false, autoCorrect = "off", autoCapitalize = "off"/,
  );
  assert.match(
    src,
    /export function Textarea\(\{ className, spellCheck = false, autoCorrect = "off", autoCapitalize = "off"/,
  );
  assert.match(src, /spellCheck=\{spellCheck\}/);
  assert.match(src, /autoCorrect=\{autoCorrect\}/);
  assert.match(src, /autoCapitalize=\{autoCapitalize\}/);
});

test("primary editable surfaces disable browser text correction", async () => {
  const files = [
    "../src/components/Composer.tsx",
    "../src/components/ChatTranscript.tsx",
    "../src/components/SearchDialog.tsx",
    "../src/components/workpanel/BrowserTab.tsx",
    "../src/pages/SettingsPage.tsx",
    "../src/pages/ProjectsPage.tsx",
    "../src/pages/PluginsPage.tsx",
    "../src/components/settings/ModelCatalogBrowser.tsx",
    "../src/components/settings/ProviderSetupDialog.tsx",
  ];

  for (const rel of files) {
    const src = await read(rel);
    for (const token of NO_CORRECTION) {
      assert.ok(src.includes(token), `${rel} must include ${token}`);
    }
  }
});
