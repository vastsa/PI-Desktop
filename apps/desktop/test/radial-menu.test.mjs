import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveRadialMenu } = await import("../src/lib/radial-menu.ts");

test("the radial menu is opt-in and keeps the released direction defaults", () => {
  assert.deepEqual(resolveRadialMenu(undefined), {
    enabled: false,
    slots: {
      up: "copy-conversation",
      right: "select-conversation",
      down: "scroll-bottom",
      left: "scroll-top",
    },
  });
  assert.equal(resolveRadialMenu({ radialMenu: {} }).enabled, false);
  assert.equal(
    resolveRadialMenu({ radialMenu: { enabled: true } }).enabled,
    true,
  );
});

test("an unknown action or a missing direction resolves per slot", () => {
  const resolved = resolveRadialMenu({
    radialMenu: { enabled: true, up: "none", down: "not-an-action" },
  });
  assert.deepEqual(resolved.slots, {
    up: "none",
    right: "select-conversation",
    down: "scroll-bottom",
    left: "scroll-top",
  });
});

test("the open actions are part of the per-slot vocabulary", () => {
  const resolved = resolveRadialMenu({
    radialMenu: {
      enabled: true,
      up: "open-browser",
      right: "open-work-panel",
      down: "open-project-folder",
    },
  });
  assert.deepEqual(resolved.slots, {
    up: "open-browser",
    right: "open-work-panel",
    down: "open-project-folder",
    left: "scroll-top",
  });
});

test("the transcript keeps the vertical menu unless the ring is enabled", () => {
  const source = readFileSync(
    new URL(
      "../src/features/chat/transcript/ChatTranscript.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /if \(radialMenu\.enabled\) \{/);
  assert.match(source, /<RadialMenu/);
  assert.match(source, /openTranscriptMenu\(event, \{/);
});

test("the settings card lives in the General tab, not AI", () => {
  const source = readFileSync(
    new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
    "utf8",
  );
  const generalIndex = source.indexOf('{tab === "general"');
  const cardIndex = source.indexOf("<RadialMenuSettings");
  const aiIndex = source.indexOf('{tab === "ai"');
  assert.ok(generalIndex >= 0 && aiIndex >= 0 && cardIndex >= 0);
  assert.ok(
    generalIndex < cardIndex && cardIndex < aiIndex,
    "RadialMenuSettings must render inside the General tab block",
  );
});

test("settings search indexes the ring under General", async () => {
  const { SETTINGS_NAV } = await import("../src/lib/settings-search.ts");
  const owner = SETTINGS_NAV.find((entry) =>
    entry.keywordKeys.includes("settings.radialMenu"),
  );
  assert.equal(owner?.id, "general");
});
