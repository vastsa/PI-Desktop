import {
  readAppSourceSync,
  readMainModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  isToolWorkPanelTab,
  parsePluginViewRef,
  pluginWorkPanelTab,
  toolWorkPanelTab,
} from "../src/lib/work-panel-tabs.ts";

/**
 * Plugin-contributed work panel views (ADR 0104).
 *
 * The surface itself is a native WebContentsView, so the behavior that can be
 * asserted here is the addressing scheme, the blank-page launcher's handling
 * of a view as a tool, and the host-side contracts that keep a view as
 * isolated as the detached panel window it shares a session partition with.
 */

const read = (path) => readFileSync(resolve(path), "utf8");
const panelSource = read("src/components/workpanel/WorkPanel.tsx");
const viewTabSource = read("src/components/workpanel/PluginViewTab.tsx");
const viewHostSource = read("electron/main/plugin-view-host.ts");
const panelHostSource = read("electron/main/plugin-panel-host.ts");
const preloadSource = read("electron/preload/plugin-panel.ts");
const mainSource = readMainSourceSync();
const pluginIpcSource = readMainModuleSync("ipc/plugin-ipc.ts");
const pluginServicesSource = readMainModuleSync("services/plugin-services.ts");
const pluginLifecycleSource = `${pluginIpcSource}\n${pluginServicesSource}`;

test("a plugin view is addressed by plugin id and view id", () => {
  const tab = pluginWorkPanelTab("acme.git", "changes");
  assert.equal(tab.kind, "plugin");
  assert.equal(tab.resource, "acme.git/changes");
  assert.equal(tab.id, "plugin:acme.git/changes");

  // Re-opening the same view must land on the same tab id, so the launcher
  // reuses the live page instead of stacking a second copy.
  assert.equal(pluginWorkPanelTab("acme.git", "changes").id, tab.id);
  assert.notEqual(pluginWorkPanelTab("other.git", "changes").id, tab.id);
  assert.notEqual(pluginWorkPanelTab("acme.git", "history").id, tab.id);
});

test("view refs round-trip, and malformed ones are refused", () => {
  assert.deepEqual(parsePluginViewRef("acme.git/changes"), {
    pluginId: "acme.git",
    viewId: "changes",
  });
  // A plugin id may contain dots; only the first slash separates.
  assert.deepEqual(parsePluginViewRef("com.acme.git/file-history"), {
    pluginId: "com.acme.git",
    viewId: "file-history",
  });
  for (const bad of [undefined, "", "no-separator", "/leading", "trailing/"]) {
    assert.equal(parsePluginViewRef(bad), null, `expected null for ${bad}`);
  }
});

test("a plugin view counts as a tool, not a transcript resource", () => {
  // Tools are the panel's stable launcher entry points; only what the
  // transcript opened belongs under "open resources".
  assert.equal(isToolWorkPanelTab(pluginWorkPanelTab("pi.browser", "browser")), true);
  assert.equal(isToolWorkPanelTab(pluginWorkPanelTab("acme.git", "changes")), true);
  assert.equal(isToolWorkPanelTab(toolWorkPanelTab("review")), false);
  assert.equal(
    isToolWorkPanelTab({ id: "file:src/a.ts", kind: "file", resource: "src/a.ts" }),
    false,
  );
});

test("the blank page launcher renders plugin views from the data-driven list", () => {
  assert.match(panelSource, /workPanelTools\(t, pluginViews\)/);
  assert.match(panelSource, /panel\.toolsAndPanels/);
  assert.match(panelSource, /pluginViews\.map\(\(view\) =>/);
  // Rows carry the same affordances as the host-owned Review row, so a plugin
  // surface is not visibly second-class.
  assert.match(panelSource, /className="work-panel-launcher-row"/);
  assert.match(panelSource, /data-work-panel-launcher-item=\{item\.id\}/);
  assert.doesNotMatch(panelSource, /role="menuitemradio"|work-panel-new-menu/);
});

test("plugin views reach the panel body and the empty state", () => {
  assert.match(panelSource, /activeTab\?\.kind === "plugin"/);
  assert.match(panelSource, /<PluginViewTab/);
  // The revealed-but-empty panel and an explicit New tab list the same
  // entries, so a user who has only plugin views installed is not shown a
  // dead end.
  assert.match(panelSource, /tools\.map[\s\S]*work-panel-launcher-row/);
  assert.match(panelSource, /activeTab\?\.kind === "new"/);
  assert.doesNotMatch(panelSource, /openPluginView\(view\)/);
});

test("the native surface keeps its full bounds while the launcher is active", () => {
  assert.match(panelSource, /blocked=\{\s*exiting \|\| panelBlocked\s*\}/s);
  assert.doesNotMatch(panelSource, /avoid: pluginSurface/);
  assert.doesNotMatch(panelSource, /menuOpen|work-panel-new-menu|placeWorkPanelMenu/);
  assert.doesNotMatch(viewTabSource, /occludedById/);
  assert.match(viewTabSource, /y: rect\.y/);
  assert.match(viewTabSource, /height: rect\.height/);
  // Visibility and bounds are separate effects: only panel-wide blocking and
  // lifecycle transitions hide the native page, so creating a New tab cannot
  // alter the active surface's measured rectangle.
  assert.match(
    viewTabSource,
    /pluginViewSetVisible\(pluginId, viewId, !blocked, sessionId\)[\s\S]*pluginViewSetBounds/s,
  );
});

test("an unknown icon token degrades instead of rendering plugin markup", () => {
  const iconSource = read("src/lib/plugin-view-icons.ts");
  // The manifest carries a token, never SVG: the icon is drawn inside host
  // chrome, so plugin markup there would be an injection surface.
  assert.doesNotMatch(iconSource, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(iconSource, /return PLUGIN_VIEW_ICON_MAP\[token\] \?\? null/);
  assert.match(panelSource, /work-panel-view-initial/);
});

test("every icon token the SDK advertises can be drawn", () => {
  // Compared as source rather than by importing the map: the map holds React
  // components from a .tsx module, which this runner cannot resolve. The lists
  // still have to agree, or a manifest that validates would render a letter
  // tile for an icon the SDK documents as supported.
  const sdkSource = read("../../packages/plugin-sdk/src/index.ts");
  const iconSource = read("src/lib/plugin-view-icons.ts");
  const declared = [
    ...sdkSource
      .slice(
        sdkSource.indexOf("export const PLUGIN_VIEW_ICONS = ["),
        sdkSource.indexOf("] as const;", sdkSource.indexOf("PLUGIN_VIEW_ICONS")),
      )
      .matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);
  const mapped = [
    ...iconSource
      .slice(
        iconSource.indexOf("PLUGIN_VIEW_ICON_MAP"),
        iconSource.indexOf("\n};", iconSource.indexOf("PLUGIN_VIEW_ICON_MAP")),
      )
      .matchAll(/^\s{2}"?([a-z-]+)"?:\s/gm),
  ].map((match) => match[1]);

  assert.ok(declared.length >= 20, "expected the SDK to advertise a real set");
  assert.deepEqual(
    declared.filter((token) => !mapped.includes(token)),
    [],
    "SDK PLUGIN_VIEW_ICONS and the renderer icon map have drifted apart",
  );
  assert.deepEqual(
    mapped.filter((token) => !declared.includes(token)),
    [],
    "the renderer draws a token the SDK does not advertise",
  );
});

test("a docked view is as isolated as a detached panel window", () => {
  // One egress policy governs both placements, so they cannot drift apart.
  assert.match(panelHostSource, /export function applyPluginEgressPolicy/);
  assert.match(viewHostSource, /applyPluginEgressPolicy\(ses, \{/);
  // Same persisted partition: a plugin's storage is one thing regardless of
  // where its page is shown.
  assert.match(panelHostSource, /export function pluginSessionPartition/);
  assert.match(viewHostSource, /session\.fromPartition\(pluginSessionPartition\(/);
  assert.match(viewHostSource, /sandbox: true/);
  assert.match(viewHostSource, /contextIsolation: true/);
  assert.match(viewHostSource, /nodeIntegration: false/);
  assert.match(viewHostSource, /webviewTag: false/);
  assert.match(viewHostSource, /preload: join\(__dirname, "\.\.\/preload\/plugin-panel\.js"\)/);
  // `window.open` would mint a chromeless window outside that policy.
  assert.match(viewHostSource, /setWindowOpenHandler\(\(\{ url \}\) =>/);
  assert.match(viewHostSource, /action: "deny"/);
});

test("a docked view cannot drive the plugin's separate panel window", () => {
  // `windowForSender` must scan windows directly. Routing it through
  // `pluginIdForSender` would let a docked view resolve to the same plugin's
  // detached window and close it.
  const windowForSender = panelHostSource.slice(
    panelHostSource.indexOf("private windowForSender"),
  );
  const body = windowForSender.slice(0, windowForSender.indexOf("\n  }"));
  assert.doesNotMatch(body, /pluginIdForSender/);
  assert.match(body, /for \(const win of this\.windows\.values\(\)\)/);
});

test("an embedded view drops the window-control chrome", () => {
  // A docked view has no window to minimize, maximize, or drag, and the
  // capsule would sit on top of the plugin's own toolbar.
  assert.match(viewHostSource, /PLUGIN_PANEL_EMBEDDED_ARGUMENT/);
  assert.match(preloadSource, /function isEmbeddedPanel\(\)/);
  assert.match(
    preloadSource,
    /if \(isEmbeddedPanel\(\)\) \{[\s\S]*--pi-plugin-titlebar-height", "0px"[\s\S]*return;/,
  );
  // The bridge is identical either way, so one HTML entry works in both.
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\("pluginBridge", bridge\)/);
});

test("only one view is attached at a time and the cache is bounded", () => {
  assert.match(viewHostSource, /const MAX_LIVE_VIEWS = \d+/);
  assert.match(viewHostSource, /private evictBeyondLimit\(\)/);
  // Never evict what is on screen.
  assert.match(viewHostSource, /\.filter\(\(entry\) => entry\.key !== this\.visibleKey\)/);
  // Showing one view detaches the previous, so a stale surface cannot linger
  // above the renderer during a fast tab switch.
  assert.match(
    viewHostSource,
    /if \(this\.visibleKey && this\.visibleKey !== key\) this\.detachVisible\(\)/,
  );
});

test("views are dropped when the plugin behind them goes away", () => {
  assert.match(viewHostSource, /closePlugin\(pluginId: string\)/);
  for (const reason of ["crash", "reload", "disable", "uninstall"]) {
    const source = reason === "crash" || reason === "reload"
      ? pluginServicesSource
      : pluginIpcSource;
    const index = source.indexOf(`reason: "${reason}"`);
    assert.ok(index > 0, `expected a ${reason} notification`);
    const before = source.slice(Math.max(0, index - 900), index);
    assert.match(
      before,
      /pluginViews\.closePlugin\(/,
      `${reason} must drop the plugin's views`,
    );
  }
  // The tab may outlive the web contents, so the renderer re-opens on the
  // lifecycle event rather than showing a permanently blank pane.
  assert.match(viewTabSource, /api\.onPluginChanged\(/);
});

test("the view list is filtered by permission, scope, and entry existence", () => {
  const handler = mainSource.slice(
    mainSource.indexOf("handle(IPC.invoke.pluginViews"),
  );
  const body = handler.slice(0, handler.indexOf("\n  handle("));
  assert.match(body, /permissions\.has\("ui\.view"\)/);
  // Unlike themes, a view is something a plugin does inside a project, so a
  // project-scoped plugin must not offer it elsewhere.
  assert.match(body, /pluginActiveInProject\(pluginId, workspacePath\)/);
  assert.match(body, /existsSync\(join\(loaded\.path, view\.entry\)\)/);
  // Opening re-checks everything the list checked: the renderer is not the
  // authority on what a plugin may show.
  const open = mainSource.slice(mainSource.indexOf("IPC.invoke.pluginViewOpen"));
  const openBody = open.slice(0, open.indexOf("\n  handle("));
  assert.match(openBody, /PERMISSION_DENIED: ui\.view/);
  assert.match(openBody, /pluginActiveInProject\(pluginId, currentWorkspacePath\(\)\)/);
  assert.match(openBody, /existsSync\(htmlPath\)/);
  // Opening Files (or any other view) must not rebind the browser guest.
  assert.match(
    openBody,
    /isBrowserView = pluginId === BROWSER_PLUGIN_ID && viewId === BROWSER_VIEW_ID/,
  );
  assert.match(openBody, /isBrowserView && sessionId/);
  assert.match(openBody, /isBrowserView && location/);
});

test("opening a different project refreshes the scope-filtered view list", () => {
  const appSource = readAppSourceSync();
  assert.match(
    appSource,
    /refreshPluginViews\(\)[\s\S]*api\.onPluginChanged\(refresh\)[\s\S]*\}, \[ready, projectPath\]\)/,
  );
});

test("host panel events reach docked views as well as detached windows", () => {
  assert.match(viewHostSource, /broadcast\(event: string, payload: unknown\)/);
  assert.match(viewHostSource, /pi-plugin-panel-event:\$\{event\}/);
  assert.match(mainSource, /function broadcastPluginPanelEvent/);
  assert.match(mainSource, /broadcastPluginPanelEvent\("appearance:changed"/);
  assert.match(mainSource, /broadcastPluginPanelEvent\("workspace:changed"/);
  assert.match(mainSource, /plugins\.broadcastEvent\("workspace:changed"/);
  assert.match(mainSource, /function setCurrentWorkspacePath/);
});
