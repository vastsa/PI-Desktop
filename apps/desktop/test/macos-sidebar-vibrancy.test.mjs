import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const stylesSource = await loadStyles();

const createWindowSource = mainSource.slice(
  mainSource.indexOf("async function createWindow()"),
);
const mainWindowBlock =
  createWindowSource.match(/mainWindow = new BrowserWindow\(\{[\s\S]*?\n  \}\);/)?.[0] ?? "";
const macOptions =
  mainWindowBlock.match(
    /\.\.\.\(process\.platform === "darwin"[\s\S]*?\n      : \{\n          frame: false,\n          backgroundColor: nativeTheme\.shouldUseDarkColors \? "#181818" : "#ffffff",\n        \}\),/,
  )?.[0] ?? "";

function styleBlock(selector) {
  return stylesSource.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

test("macOS main window enables native sidebar vibrancy only in its platform branch", () => {
  assert.match(macOptions, /titleBarStyle:\s*"hiddenInset"/);
  assert.match(macOptions, /trafficLightPosition:\s*\{ x: 16, y: 16 \}/);
  assert.match(macOptions, /vibrancy:\s*"sidebar"/);
  assert.match(macOptions, /visualEffectState:\s*"followWindow"/);
  assert.match(macOptions, /transparent:\s*true/);
  assert.match(macOptions, /backgroundColor:\s*"#00000000"/);

  // The shared opaque fallback remains in place for Windows/Linux.
  assert.match(
    mainWindowBlock,
    /backgroundColor:\s*nativeTheme\.shouldUseDarkColors \? "#181818" : "#ffffff"/,
  );
  assert.match(mainWindowBlock, /frame: false/);
});

test("only macOS sidebar surfaces receive the translucent theme tint", () => {
  const macSidebarBlock =
    stylesSource.match(
      /:root\[data-platform="darwin"\] \.sidebar,\n:root\[data-platform="darwin"\] \.sidebar-rail\s*\{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(macSidebarBlock, /background:\s*color-mix\(in oklab, var\(--ds-bg-sidebar\) 78%, transparent\)/);
  assert.match(
    macSidebarBlock,
    /border-right-color:\s*color-mix\(in oklab, var\(--ds-text-primary\) 8%, transparent\)/,
  );

  const macAncestorBlock =
    stylesSource.match(
      /:root\[data-platform="darwin"\],\n:root\[data-platform="darwin"\] body,\n:root\[data-platform="darwin"\] #root,\n:root\[data-platform="darwin"\] \.app-shell\s*\{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(macAncestorBlock, /background:\s*transparent/);

  const mainPaneBlock = styleBlock("\\.main-pane");
  const mainTitlebarBlock = styleBlock("\\.main-titlebar");
  const conversationTopbarBlock = styleBlock("\\.conversation-topbar");
  for (const block of [mainPaneBlock, mainTitlebarBlock, conversationTopbarBlock]) {
    assert.match(block, /background:\s*var\(--ds-bg-primary\)/);
    assert.doesNotMatch(block, /transparent/);
  }
});
