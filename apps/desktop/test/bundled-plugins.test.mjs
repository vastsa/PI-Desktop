import { readStoreSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Bundled first-party plugins (ADR 0104).
 *
 * The point of shipping Files as a plugin rather than host code is that it
 * proves the public contribution channel is sufficient. These assertions guard
 * that property: the manifest must be an ordinary one, the plugin must reach
 * the panel through `contributes.views`, and it must not depend on anything a
 * third-party plugin could not also declare.
 */

const read = (path) => readFileSync(resolve(path), "utf8");
const manifest = JSON.parse(read("resources/plugins/pi.files/manifest.json"));
const view = read("resources/plugins/pi.files/views/tree.html");
const panelSource = read("src/components/workpanel/WorkPanel.tsx");
const hostProcessSource = read("electron/main/host-process.ts");
const packageJson = JSON.parse(read("package.json"));

test("Files ships as an ordinary plugin, not a privileged one", () => {
  assert.equal(manifest.id, "pi.files");
  assert.deepEqual(manifest.contributes.views.map((v) => v.id), ["tree"]);
  // Exactly the permissions a third party would have to declare for the same
  // capability — nothing host-only.
  assert.deepEqual([...manifest.permissions].sort(), ["fs.read", "ui.view"]);
  assert.equal(manifest.fs.read.root, "workspace");
  assert.deepEqual(manifest.fs.read.scope, ["**"]);
  // A localized title, because the panel menu shows it to the user.
  assert.equal(typeof manifest.contributes.views[0].title.en, "string");
  assert.equal(typeof manifest.contributes.views[0].title["zh-CN"], "string");
});

test("the Files view uses only public bridge channels", () => {
  for (const channel of [
    "fs.list",
    "fs.readPreview",
    "fs.glob",
    "fs.openDefault",
    "fs.reveal",
    "workspace.get",
    "app.getAppearance",
  ]) {
    assert.ok(
      view.includes(`"${channel}"`),
      `expected the view to call ${channel} over the bridge`,
    );
  }
  // No Node, no Electron, no host internals: it is a sandboxed page.
  assert.doesNotMatch(view, /require\(|import\s+.*from\s+["']node:|ipcRenderer/);
  // The titlebar height is read, not hard-coded, so the same file also works
  // in a detached panel window.
  assert.match(view, /var\(--pi-plugin-titlebar-height, 0px\)/);
  assert.match(view, /meta name="pi-plugin-chrome" content="v2"/);
});

test("the Files view keeps the former browser workflow while staying plugin-owned", () => {
  // The old host FilesTab established the useful interaction contract: a
  // lazy tree opens a focused viewer, and Back returns to the same selection.
  // Keep those affordances in the isolated plugin page so moving ownership did
  // not make the feature less capable.
  for (const marker of [
    'id="refresh"',
    'id="back"',
    'id="viewer-body"',
    'id="reveal"',
    'id="open"',
    'id="search"',
    'role="tree"',
    'role", "treeitem"',
    'aria-expanded',
    'MAX_LINES = 5000',
    'prefers-reduced-motion: reduce',
  ]) {
    assert.ok(view.includes(marker), `expected Files view marker: ${marker}`);
  }
  assert.match(view, /fs\.readPreview/);
  assert.match(view, /fs\.openDefault/);
  assert.match(view, /fs\.reveal/);
  assert.match(view, /fs\.glob/);
  assert.match(view, /workspace:changed/);
  assert.match(view, /kind === "image"/);
  assert.match(view, /kind === "tooLarge"/);
  assert.match(view, /content\.includes\("\\0"\)/);
  assert.match(view, /appearance:changed/);
  assert.match(view, /locale.*startsWith\("zh"\)/);
  assert.match(view, /retry/);
  assert.match(view, /refreshing/);
  assert.match(view, /mini-spinner/);
  assert.match(view, /aria-busy/);
  assert.match(view, /direction:\s*rtl/);
  assert.match(view, /globFromQuery/);
  assert.doesNotMatch(view, /setInterval/);
  assert.doesNotMatch(view, /SPLIT_MIN|app\.split/);
  // The main app is intentionally monochrome; the bundled view must not
  // drift back to the blue accent it used before joining the host palette.
  assert.doesNotMatch(view, /#7aa2f7|#2563eb|#22c55e/);
  // The plugin cannot reach host-only reveal or renderer APIs. Keeping this
  // page on the public bridge is part of the bundled-plugin contract.
  assert.doesNotMatch(view, /fsReveal|ipcRenderer|require\(/);
});

test("the host no longer offers Files or Browser as built-in tools", () => {
  assert.doesNotMatch(panelSource, /const HEADER_TOOLS/);
  assert.doesNotMatch(panelSource, /kind: "browser"/);
  assert.doesNotMatch(panelSource, /kind: "terminal"/);
  // Review and file remain artifact/resource surfaces the conversation opens.
  assert.match(panelSource, /activeTab\?\.kind === "file"/);
  assert.match(panelSource, /activeTab\?\.kind === "review"/);
});

test("Review still opens itself from workspace edit artifacts", () => {
  // Removing the launcher entry must not remove the way Review appears at all.
  const storeSource = readStoreSourceSync();
  assert.match(storeSource, /shouldOpenReviewArtifact\(\{/);
  assert.match(storeSource, /toolWorkPanelTab\("review"\)/);
});

test("Browser ships as an ordinary plugin over the public CDP API", () => {
  const browserManifest = JSON.parse(read("resources/plugins/pi.browser/manifest.json"));
  const browserMain = read("resources/plugins/pi.browser/main.js");
  const browserView = read("resources/plugins/pi.browser/views/browser.html");
  assert.equal(browserManifest.id, "pi.browser");
  assert.deepEqual(browserManifest.contributes.views.map((v) => v.id), ["browser"]);
  assert.deepEqual(
    [...browserManifest.permissions].sort(),
    ["agent.tool.register", "browser.cdp", "ui.view"],
  );
  assert.equal(typeof browserManifest.contributes.views[0].title.en, "string");
  assert.equal(typeof browserManifest.contributes.views[0].title["zh-CN"], "string");
  assert.match(browserMain, /pi\.agent\.registerTool/);
  assert.match(browserMain, /pi\.browser\.(navigate|snapshot|cdp)/);
  assert.match(browserView, /pluginBridge/);
  assert.match(browserView, /browser\.setBounds/);
  assert.doesNotMatch(browserView, /require\(|ipcRenderer|webview/);
});

test("Browser declares plan-safe actions for Plan-mode URL inspection (ADR 0211)", () => {
  const browserMain = read("resources/plugins/pi.browser/main.js");
  // The planSafeActions list must be declared on the registered tool.
  assert.match(browserMain, /planSafeActions\s*:\s*PLAN_SAFE_ACTIONS/);
  // The list itself must declare the four read-only actions the user needs.
  assert.match(
    browserMain,
    /PLAN_SAFE_ACTIONS\s*=\s*\[\s*"navigate"\s*,\s*"snapshot"\s*,\s*"screenshot"\s*,\s*"console"\s*\]/,
  );
  // The mutating actions must NOT appear in PLAN_SAFE_ACTIONS, otherwise
  // Plan mode would be able to click/fill/evaluate arbitrary pages.
  const planSafeMatch = browserMain.match(/PLAN_SAFE_ACTIONS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(planSafeMatch, "PLAN_SAFE_ACTIONS array must exist");
  for (const unsafe of ["click", "fill", "evaluate", "cdp"]) {
    assert.doesNotMatch(
      planSafeMatch[1],
      new RegExp('"' + unsafe + '"'),
      `mutating action ${unsafe} must not appear in PLAN_SAFE_ACTIONS`,
    );
  }
});


test("Advisor is temporarily not bundled", () => {
  assert.equal(existsSync(resolve("resources/plugins/pi.advisor")), false);
});

test("bundled plugins are packaged and located at runtime", () => {
  assert.ok(
    packageJson.build.extraResources.some(
      (entry) => entry.from === "resources/plugins" && entry.to === "plugins",
    ),
    "resources/plugins must be copied outside the asar",
  );
  // host-core cannot know whether it runs from resources/ or a checkout, so
  // Electron resolves the directory and hands it over.
  assert.match(hostProcessSource, /function resolveBuiltinPluginsDir\(\)/);
  assert.match(hostProcessSource, /PI_DESKTOP_BUILTIN_PLUGINS_DIR/);
  assert.match(hostProcessSource, /join\(process\.resourcesPath \|\| "", "plugins"\)/);
});
