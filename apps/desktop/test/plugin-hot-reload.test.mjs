import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");

const watcherSrc = readFileSync(join(desktopRoot, "electron/main/plugin-watcher.ts"), "utf8");
const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const mainSrc = readFileSync(join(desktopRoot, "electron/main/index.ts"), "utf8");

function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} missing`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `${to} missing after ${from}`);
  return source.slice(start, end);
}

test("a save burst produces one reload, and build output produces none", () => {
  assert.match(watcherSrc, /RELOAD_DEBOUNCE_MS = 300/);
  // Each event restarts the timer, so N writes in one burst reload once.
  const onEvent = slice(watcherSrc, "private onEvent(", "\n}");
  assert.match(onEvent, /if \(existing\) clearTimeout\(existing\)/);
  assert.match(onEvent, /if \(isIgnoredWatchPath\(relative\)\) return/);
  // A plugin writing into its own dist/ must not reload itself forever.
  for (const ignored of ["node_modules", ".git", "dist"]) {
    assert.ok(
      watcherSrc.includes(`"${ignored}"`),
      `${ignored} must not trigger a reload`,
    );
  }
  // A pending reload must not keep the app alive at quit.
  assert.match(onEvent, /timer\.unref\?\.\(\)/);
});

test("watching degrades instead of failing where recursion is unavailable", () => {
  assert.match(watcherSrc, /fsWatch\(dir, \{ recursive: true \}, listener\)/);
  const fallback = slice(watcherSrc, "const defaultWatch", "/**\n * Watches");
  assert.ok(
    fallback.indexOf("recursive: true") < fallback.indexOf("fsWatch(dir, listener)"),
    "flat watch is the fallback, not the default",
  );
  assert.match(watcherSrc, /MAX_WATCHED_PLUGINS = 16/);
  assert.match(watcherSrc, /watcher limit reached/);
});

test("hot reload can never widen the permissions the user approved", () => {
  const reload = slice(runtimeSrc, "async reloadDevPlugin(", "\n  async invokePanelBridge");
  assert.match(reload, /readDeclaredAccess\(dev\.path\)/);
  assert.match(reload, /new Set\(dev\.permissions\)/);
  assert.match(reload, /PERMISSION_DENIED: manifest now requests/);
  // The refusal comes before anything is loaded.
  assert.ok(
    reload.indexOf("PERMISSION_DENIED") < reload.indexOf("this.loadFromPath"),
    "the permission check must precede the load",
  );
  // Grants track the manifest downwards, so a removed permission goes away.
  assert.match(reload, /this\.loadFromPath\(dev\.path, declared, \{ development: true \}\)/);
  // The ceiling stays what the user approved, not what the last reload used.
  assert.match(reload, /permissions: dev\.permissions/);
  // The ceiling covers file scope too, not just permission names: a reload that
  // adds a glob is asking for more than the user approved.
  assert.match(reload, /widenedFsScope\(dev\.fs, declaredAccess\.fs\)/);
  // An unreadable manifest grants nothing.
  const declared = slice(runtimeSrc, "function readDeclaredAccess(", "\nfunction widenedFsScope");
  assert.match(declared, /PLUGIN_INVALID: manifest\.json missing/);
});

test("a broken plugin stays watched so the next save can fix it", () => {
  const unload = slice(runtimeSrc, "async unload(pluginId: string)", "\n  /**");
  assert.match(unload, /if \(!this\.reloading\.has\(pluginId\)\)/);
  assert.match(unload, /this\.watcher\.remove\(pluginId\)/);
  assert.match(unload, /this\.devPlugins\.delete\(pluginId\)/);
  // reloadDevPlugin works from its own record, not from the loaded map, which a
  // failed reload has already emptied.
  const reload = slice(runtimeSrc, "async reloadDevPlugin(", "\n  async invokePanelBridge");
  assert.match(reload, /const dev = this\.devPlugins\.get\(pluginId\)/);
  assert.match(reload, /this\.reloading\.add\(pluginId\)/);
  assert.match(reload, /finally \{\s*this\.reloading\.delete\(pluginId\)/);
  // Both outcomes are reported; neither throws at the watcher.
  assert.match(reload, /plugin\.reload\.success/);
  assert.match(reload, /plugin\.reload\.error/);
  assert.doesNotMatch(reload, /throw error/);
});

test("every path that loads a dev plugin arms the watcher", () => {
  // Folder picker, template scaffold, agent tool, startup restore, re-enable.
  assert.match(mainSrc, /if \(loaded\.plugin\?\.id\) plugins\.watchDevPlugin\(loaded\.plugin\.id\)/);
  assert.match(mainSrc, /plugins\.watchDevPlugin\(created\.id\)/);
  assert.match(mainSrc, /plugins\.watchDevPlugin\(manifest\.id\)/);
  assert.match(mainSrc, /if \(p\.source === "dev"\) plugins\.watchDevPlugin\(p\.id\)/);
  assert.match(mainSrc, /if \(res\.plugin\.source === "dev"\) plugins\.watchDevPlugin\(id\)/);
});

test("manual reload uses the registry path and refreshes the dev permission ceiling", () => {
  const reload = slice(mainSrc, "handle(IPC.invoke.pluginReload", "// Scaffold a starter plugin");
  assert.match(reload, /host\.call<\{ plugins: any\[\] \}>\("plugins\.list"\)/);
  assert.match(reload, /find\(\(candidate\) => candidate\?\.id === id\)/);
  assert.match(
    reload,
    /plugins\.loadFromPath\(plugin\.path, plugin\.permissions \?\? \[\], \{\s*development: plugin\.source === "dev",\s*\}\)/,
  );
  assert.match(reload, /if \(plugin\.source === "dev"\) plugins\.watchDevPlugin\(id\)/);
  assert.match(reload, /reason: "reload", pluginId: id/);
});

test("watchers are released on teardown and reloads reach the renderer", () => {
  const quit = slice(mainSrc, 'app.on("before-quit"', "});");
  // Quit tears the whole plugin subsystem down; watch disposal rides along
  // inside it rather than being called on its own.
  assert.match(quit, /plugins\.disposeAll\(\)/);
  const disposeAll = slice(runtimeSrc, "async disposeAll(", "\n  }");
  assert.match(disposeAll, /this\.disposeWatchers\(\)/);
  const reported = slice(mainSrc, "onPluginReloaded:", "\n  },");
  assert.match(reported, /IPC\.event\.toast/);
  assert.match(reported, /IPC\.event\.pluginChanged, \{ reason: "reload", pluginId \}/);
  assert.match(reported, /Reload failed/);
});
