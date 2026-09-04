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

test("macOS main window enables native under-window vibrancy only in its platform branch", () => {
  assert.match(macOptions, /titleBarStyle:\s*"hiddenInset"/);
  assert.match(macOptions, /trafficLightPosition:\s*\{ x: 16, y: 16 \}/);
  assert.match(macOptions, /vibrancy:\s*"under-window"/);
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

test("only macOS sidebar surfaces receive the translucent glass treatment", () => {
  const macSidebarBlock =
    stylesSource.match(
      /:root\[data-platform="darwin"\] \.sidebar,\n:root\[data-platform="darwin"\] \.sidebar-rail\s*\{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(macSidebarBlock, /background-color:\s*var\(--ds-sidebar-glass-tint\)/);
  // Sheen, not a flat tint — this is what keeps the material reading as glass.
  assert.match(macSidebarBlock, /var\(--ds-sidebar-glass-sheen-top\)/);
  assert.match(macSidebarBlock, /var\(--ds-sidebar-glass-sheen-bottom\)/);
  // No dock seam on any platform (D297): neither the macOS glass rule nor the
  // base `.sidebar` rule draws a right edge, so the glass meets the opaque main
  // pane flush and no transparent override is needed.
  assert.doesNotMatch(macSidebarBlock, /border-right/);
  const baseSidebarBlock = stylesSource.match(/\n\.sidebar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(baseSidebarBlock, /border-right/);

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

test("the sidebar glass tint stays thin enough to reveal the vibrancy material", () => {
  // Slice at the @theme block so later partials cannot fake a token, and match
  // the light selector at a line start — the file header comment quotes it.
  const tokenSource = stylesSource.slice(0, stylesSource.indexOf("@theme {"));
  const lightIndex = /\n:root\[data-theme="light"\]\s*\{/.exec(tokenSource)?.index ?? -1;
  assert.ok(lightIndex > 0, "expected a light theme token block");
  const themes = {
    dark: tokenSource.slice(0, lightIndex),
    light: tokenSource.slice(lightIndex),
  };

  for (const [theme, block] of Object.entries(themes)) {
    for (const token of [
      "--ds-sidebar-glass-tint",
      "--ds-sidebar-glass-sheen-top",
      "--ds-sidebar-glass-sheen-bottom",
    ]) {
      assert.match(block, new RegExp(`${token}:`), `${theme} must define ${token}`);
    }
    const tint = block.match(
      /--ds-sidebar-glass-tint:\s*color-mix\(in oklab,\s*var\(--ds-bg-sidebar\)\s*(\d+)%,\s*transparent\)/,
    );
    assert.ok(tint, `${theme}: tint must derive from --ds-bg-sidebar`);
    assert.ok(
      Number(tint[1]) <= 60,
      `${theme}: tint ${tint[1]}% is too opaque for the material to show through`,
    );
  }
});
