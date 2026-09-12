import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hostSource = await readFile(
  new URL("../electron/main/plugin-panel-host.ts", import.meta.url),
  "utf8",
);
const preloadSource = await readFile(
  new URL("../electron/preload/plugin-panel.ts", import.meta.url),
  "utf8",
);
const chromeSource = await readFile(
  new URL("../electron/shared/plugin-panel-chrome.ts", import.meta.url),
  "utf8",
);
const examplePanelSource = await readFile(
  new URL("../../../examples/plugins/hello/renderer/index.html", import.meta.url),
  "utf8",
);
const hostCorePluginSource = await readFile(
  new URL("../../../crates/host-core/src/plugins.rs", import.meta.url),
  "utf8",
);
const bundledPanelSources = [
  ...hostCorePluginSource.matchAll(/"renderer\/index\.html",\s*br#"(.*?)"#,/gs),
].map((match) => match[1]);

test("plugin panels match the cross-platform main-window chrome contract", () => {
  assert.match(hostSource, /frame: false/);
  assert.doesNotMatch(hostSource, /titleBarStyle|trafficLightPosition/);
  assert.match(hostSource, /request\.theme === "light"/);
  assert.match(hostSource, /win\.setMenu\(null\)/);
  assert.match(hostSource, /pi-plugin-panel-development=1/);
  assert.match(chromeSource, /PLUGIN_PANEL_TITLEBAR_HEIGHT = 46/);
  assert.match(preloadSource, /-webkit-app-region: drag/);
  assert.match(preloadSource, /className = "capsule"/);
  assert.match(preloadSource, /top: 9px/);
  assert.match(preloadSource, /right: 8px/);
  assert.match(preloadSource, /width: 96px/);
  assert.match(preloadSource, /height: 28px/);
  assert.match(preloadSource, /border-radius: 999px/);
  assert.match(preloadSource, /controls\.append\(minimize, maximize, close\)/);
  const capsuleBlock = preloadSource.slice(
    preloadSource.indexOf("    .capsule {"),
    preloadSource.indexOf("    .control {"),
  );
  assert.doesNotMatch(capsuleBlock, /box-shadow:|backdrop-filter:/);
  assert.doesNotMatch(preloadSource, /function panelTitle|panelTitle\(/);
  assert.doesNotMatch(preloadSource, /platform-darwin|padding-left: 76px|width: 112px/);
});

test("plugin panel window controls stay private, bounded, and accessible", () => {
  for (const action of ["getState", "minimize", "toggleMaximize", "close"]) {
    assert.match(chromeSource, new RegExp(`"${action}"`));
  }
  assert.match(hostSource, /isPluginPanelWindowControlAction\(rawAction\)/);
  assert.match(hostSource, /this\.windowForSender\(event\.sender\.id\)/);
  assert.match(preloadSource, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(preloadSource, /setAttribute\("aria-label", label\)/);
  assert.match(preloadSource, /focus-visible/);
  assert.match(preloadSource, /pageColor\("backgroundColor"/);
  assert.match(preloadSource, /--pi-plugin-panel-page-background/);
  assert.match(preloadSource, /cursor: pointer/);
  const publicBridgeSource = preloadSource.slice(
    preloadSource.indexOf("const bridge ="),
    preloadSource.indexOf('contextBridge.exposeInMainWorld("pluginBridge"'),
  );
  assert.doesNotMatch(
    publicBridgeSource,
    /windowControl|PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL/,
  );
});

test("plugin panels expose host-owned dropped-file authorization", () => {
  assert.match(preloadSource, /webUtils\.getPathForFile\(file\)/);
  assert.match(preloadSource, /pi-plugin-panel-drop/);
  assert.match(preloadSource, /event\.dataTransfer\?\.files/);
  assert.match(hostSource, /fs\.registerDropped/);
  assert.match(hostSource, /consumeDroppedPath\(event\.sender\.id, payload\?\.path\)/);
  assert.match(hostSource, /DROPPED_PATH_TTL_MS/);
});

test("plugin panel close does not read destroyed webContents", () => {
  assert.match(
    hostSource,
    /const webContentsId = win\.webContents\.id;\s*win\.on\("closed", \(\) => \{\s*this\.pendingDrops\.delete\(webContentsId\);/,
  );
  const closedHandler = hostSource.slice(
    hostSource.indexOf('win.on("closed"'),
    hostSource.indexOf("this.windows.set(request.pluginId, win);"),
  );
  assert.doesNotMatch(closedHandler, /win\.webContents/);
});

test("plugin content is offset below the strict 46px host drag band", () => {
  assert.match(preloadSource, /getComputedStyle\(body\)\.paddingTop/);
  assert.match(preloadSource, /padding-top/);
  assert.match(preloadSource, /PLUGIN_PANEL_CHROME_META_NAME/);
  assert.match(preloadSource, /PLUGIN_PANEL_CHROME_VERSION/);
  assert.match(preloadSource, /pluginOwnsTitlebarSpacing/);
  assert.match(preloadSource, /PLUGIN_PANEL_TITLEBAR_HEIGHT/);
  assert.match(preloadSource, /--pi-plugin-titlebar-height/);
  assert.match(preloadSource, /isDevelopmentPanel/);
  assert.match(preloadSource, /safe-area-hint/);
  assert.match(preloadSource, /顶部 46px 为拖拽区/);
  assert.match(preloadSource, /外掛面板視窗控制項/);
  assert.match(preloadSource, /頂部 46px 為拖曳區/);
  assert.match(preloadSource, /플러그인 패널 창 컨트롤/);
  assert.match(preloadSource, /상단 46px는 드래그 전용/);
  assert.match(preloadSource, /locale\.startsWith\("ko"\)/);
  assert.match(preloadSource, /locale\.startsWith\("tr"\)/);
  assert.match(preloadSource, /locale\.startsWith\("de"\)/);
  assert.match(preloadSource, /locale\.startsWith\("es"\)/);
  assert.match(preloadSource, /locale\.startsWith\("fr"\)/);
  assert.match(preloadSource, /locale === "zh-tw"/);
  assert.match(preloadSource, /locale === "zh-hant"/);
  assert.match(preloadSource, /--pi-plugin-panel-theme=/);
  assert.match(preloadSource, /PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX/);
  assert.match(preloadSource, /function chromeLabels\(input = panelLocale\(\)\)/);
  assert.match(preloadSource, /input\.replaceAll\("_", "-"\)\.toLowerCase\(\)/);
  assert.match(preloadSource, /appearance\?\.locale/);
  assert.match(preloadSource, /labels = chromeLabels\(appearance\.locale\)/);
  assert.match(preloadSource, /host\.dataset\.theme = theme/);
  assert.match(preloadSource, /className = "drag-region"/);
  assert.match(preloadSource, /prefers-reduced-motion: reduce/);
});

test("plugin panel documents use the compact global scrollbar contract", () => {
  assert.match(preloadSource, /function installPluginScrollbarStyle\(\)/);
  assert.match(
    preloadSource,
    /::-webkit-scrollbar\s*\{[\s\S]*?width: 6px;[\s\S]*?height: 6px;/,
  );
  assert.match(preloadSource, /::-webkit-scrollbar-track[\s\S]*?background: transparent/);
  assert.match(preloadSource, /:focus-within::\-webkit-scrollbar-thumb/);
  assert.match(preloadSource, /\[data-scrolling\]::\-webkit-scrollbar-thumb/);
  assert.match(preloadSource, /document\.addEventListener\("scroll", onScroll/);
  assert.match(preloadSource, /installPluginScrollbarStyle\(\);/);
});

test("paint-through panels let page content draw and receive pointer events", () => {
  assert.match(chromeSource, /PLUGIN_PANEL_CHROME_PAINT_THROUGH_VERSION = "v3"/);
  assert.match(preloadSource, /type PluginPanelChromeMode = "legacy" \| "safe-area" \| "paint-through"/);
  assert.match(preloadSource, /host\.dataset\.chromeMode = chromeMode/);
  assert.match(
    preloadSource,
    /:host\(\[data-chrome-mode="paint-through"\]\) \.drag-region[\s\S]*-webkit-app-region: no-drag;[\s\S]*pointer-events: none;/,
  );
  assert.match(preloadSource, /className = "drag-segment"/);
  assert.match(preloadSource, /data-pi-plugin-no-drag/);
  assert.match(preloadSource, /installPaintThroughDragMap\(dragRegion\)/);
  // The host capsule and computed empty-space segments remain in the shadow
  // tree; holes in the segment map expose page controls to real pointer input.
  assert.match(preloadSource, /className = "capsule"/);
  assert.match(preloadSource, /controls\.append\(minimize, maximize, close\)/);
});

test("checked-in plugin panels follow the host chrome contract", () => {
  assert.equal(bundledPanelSources.length, 2);
  for (const panelSource of [examplePanelSource, ...bundledPanelSources]) {
    assert.match(panelSource, /meta name="pi-plugin-chrome" content="v2"/);
    assert.match(panelSource, /PI-Desktop reserves exactly a transparent 46px drag band/);
    assert.match(panelSource, /var\(--pi-plugin-titlebar-height, 46px\)/);
    assert.doesNotMatch(panelSource, /top:\s*0/);
  }
});
