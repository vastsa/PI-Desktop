import assert from "node:assert/strict";
import test from "node:test";

import {
  LAUNCHER_COLUMNS,
  LAUNCHER_MATCH_TILES,
  LAUNCHER_PINNED_TILES,
  LAUNCHER_RECENT_TILES,
  buildLauncherAllPluginsSection,
  buildLauncherPinnedSection,
  buildLauncherRecentSection,
  indexLauncherCatalog,
  matchLauncherTrigger,
  searchLauncherItems,
} from "../src/lib/launcher-search.ts";

const EMPTY_STORE = {
  recents: [],
  pins: [],
  disabledPlugins: [],
  disabledTriggers: [],
};

function plugin(id, name, extra = {}) {
  return {
    kind: "plugin",
    id: `plugin:${id}`,
    pluginId: id,
    name,
    triggers: [],
    ...extra,
  };
}

function app(key, name, extra = {}) {
  return {
    kind: "app",
    id: `app:${key}`,
    name,
    source: "start-menu",
    ...extra,
  };
}

function catalog(plugins = [], apps = []) {
  return { plugins, apps, appsScanning: false };
}

function search(items, query, store = EMPTY_STORE) {
  return searchLauncherItems(
    indexLauncherCatalog(items, store),
    query,
    store,
  );
}

test("the grid is 8 columns wide with the documented row budget", () => {
  assert.equal(LAUNCHER_COLUMNS, 8);
  assert.equal(LAUNCHER_RECENT_TILES, 16);
  assert.equal(LAUNCHER_PINNED_TILES, 8);
  assert.equal(LAUNCHER_MATCH_TILES, 24);
});

test("a tile carries the name, the monogram, and nothing that explains the match", () => {
  const items = catalog([], [app("chrome", "Google Chrome")]);

  const tile = search(items, "chrome").tiles[0];

  assert.equal(tile.kind, "app");
  assert.equal(tile.name, "Google Chrome");
  assert.equal(tile.monogram, "G");
  assert.equal("detail" in tile, false);
  assert.equal("reason" in tile, false);
});

test("a declared trigger outranks a plugin whose name merely contains the input", () => {
  const items = catalog([
    plugin("calc.name-only", "1+1 helper"),
    plugin("calculator", "计算器", {
      triggers: [{ id: "expr", pattern: "^[0-9+\\-*/(). ]+$" }],
    }),
  ]);

  const result = search(items, "1+1");

  assert.equal(result.tiles[0].id, "plugin:calculator");
  assert.deepEqual(result.tiles[0].trigger, { id: "expr", payload: "1+1" });
});

test("a trigger hit appears once: it is not scored against the name as well", () => {
  // The plugin's name would also match the input, which used to be able to
  // surface the same plugin twice: once for the pattern, once for the name.
  const items = catalog([
    plugin("calculator", "== 1+1 ==", {
      triggers: [{ id: "expr", pattern: "^[0-9+\\-*/(). ]+$" }],
    }),
  ]);

  const result = search(items, "1+1");

  assert.equal(result.total, 1);
  assert.equal(result.tiles.length, 1);
  assert.deepEqual(result.tiles[0].trigger, { id: "expr", payload: "1+1" });
});

test("trigger matching is a whole-input match, not contains", () => {
  const trigger = { id: "expr", pattern: "^[0-9]+$" };

  assert.equal(matchLauncherTrigger(trigger, "123"), "123");
  assert.equal(matchLauncherTrigger(trigger, "123+"), null);
  assert.equal(matchLauncherTrigger(trigger, " 123 "), null);
});

test("an input longer than the trigger budget never runs a declared pattern", () => {
  const trigger = { id: "expr", pattern: "^.*$" };
  const garbage = "乱".repeat(500);

  assert.equal(matchLauncherTrigger(trigger, garbage), null);
  const result = search(
    catalog([plugin("calculator", "计算器", { triggers: [trigger] })]),
    garbage,
  );
  assert.equal(result.total, 0);
});

test("an unusable pattern is ignored instead of throwing on every keystroke", () => {
  const result = search(
    catalog([
      plugin("broken", "Broken", { triggers: [{ id: "bad", pattern: "([a-z" }] }),
    ]),
    "1",
  );

  assert.deepEqual(result.tiles, []);
  assert.equal(result.total, 0);
});

test("Chinese names match by full pinyin and by initials", () => {
  const items = catalog([], [app("wechat", "微信")]);

  assert.equal(search(items, "weixin").tiles[0].id, "app:wechat");
  assert.equal(search(items, "wx").tiles[0].id, "app:wechat");
  assert.equal(search(items, "微信").tiles[0].id, "app:wechat");
});

test("an application's icon data URL reaches the tile", () => {
  const items = catalog([], [
    app("chrome", "Chrome", { iconDataUrl: "data:image/png;base64,AAAA" }),
  ]);

  assert.equal(
    search(items, "chrome").tiles[0].iconDataUrl,
    "data:image/png;base64,AAAA",
  );
});

test("plugins never carry an application icon", () => {
  const items = catalog([plugin("notes", "Notes")]);

  assert.equal(search(items, "notes").tiles[0].iconDataUrl, undefined);
});

test("same-named plugin and application both appear, plugins first", () => {
  const items = catalog(
    [plugin("calculator", "计算器")],
    [app("calculator-app", "计算器")],
  );

  const result = search(items, "计算器");

  assert.equal(result.total, 2);
  assert.deepEqual(
    result.tiles.map((tile) => tile.kind),
    ["plugin", "app"],
  );
});

test("matches past the 3-row budget are counted but not rendered", () => {
  const apps = Array.from({ length: 30 }, (_, index) =>
    app(`app-${index}`, `Tool ${index}`),
  );

  const result = search(catalog([], apps), "tool");

  assert.equal(result.tiles.length, 24);
  assert.equal(result.total, 30);
});

test("a description-only match ranks last", () => {
  const items = catalog([
    plugin("notes", "Notes", { description: "Write markdown" }),
    plugin("markdown", "Markdown"),
  ]);

  const result = search(items, "markdown");

  assert.equal(result.tiles[0].id, "plugin:markdown");
  assert.equal(result.tiles[1].id, "plugin:notes");
});

test("recents report their real total while the grid shows two rows", () => {
  const apps = Array.from({ length: 20 }, (_, index) =>
    app(`app-${index}`, `App ${index}`),
  );
  const store = {
    ...EMPTY_STORE,
    recents: apps.map((entry) => entry.id),
  };

  const section = buildLauncherRecentSection(
    indexLauncherCatalog(catalog([], apps), store),
    store,
  );

  assert.equal(section.tiles.length, 16);
  assert.equal(section.total, 20);
});

test("pins show one row and keep the pin order", () => {
  const apps = [app("a", "A"), app("b", "B"), app("c", "C")];
  const store = { ...EMPTY_STORE, pins: ["app:c", "app:a", "app:b"] };

  const section = buildLauncherPinnedSection(
    indexLauncherCatalog(catalog([], apps), store),
    store,
  );

  assert.deepEqual(
    section.tiles.map((tile) => tile.id),
    ["app:c", "app:a", "app:b"],
  );
});

test("the all-plugins view lists plugins only, recently used first", () => {
  const items = catalog(
    [plugin("alpha", "Alpha"), plugin("beta", "Beta"), plugin("gamma", "Gamma")],
    [app("chrome", "Chrome")],
  );
  const store = { ...EMPTY_STORE, recents: ["plugin:gamma"] };

  const section = buildLauncherAllPluginsSection(
    indexLauncherCatalog(items, store),
    store,
  );

  assert.deepEqual(
    section.tiles.map((tile) => tile.id),
    ["plugin:gamma", "plugin:alpha", "plugin:beta"],
  );
  assert.equal(section.total, 3);
  assert.deepEqual(
    section.tiles.filter((tile) => tile.kind !== "plugin"),
    [],
  );
});

test("a plugin the user hid from the launcher is not searchable", () => {
  const items = catalog([plugin("noisy", "Noisy"), plugin("quiet", "Quiet")]);
  const store = { ...EMPTY_STORE, disabledPlugins: ["noisy"] };

  const result = search(items, "no", store);

  assert.deepEqual(
    result.tiles.map((tile) => tile.id),
    [],
  );
  assert.equal(search(items, "quiet", store).tiles.length, 1);
});

test("a disabled trigger no longer claims the input", () => {
  const items = catalog([
    plugin("calculator", "计算器", {
      triggers: [{ id: "expr", pattern: "^[0-9+]+$" }],
    }),
  ]);
  const store = { ...EMPTY_STORE, disabledTriggers: ["calculator::expr"] };

  const result = search(items, "1+1", store);

  assert.equal(result.tiles.length, 0);
});

test("recency breaks a tie between equal matches", () => {
  const items = catalog([plugin("alpha", "Tool A"), plugin("beta", "Tool B")]);
  const store = { ...EMPTY_STORE, recents: ["plugin:beta"] };

  const noHistory = search(items, "tool");
  const withHistory = search(items, "tool", store);

  assert.equal(noHistory.tiles[0].id, "plugin:alpha");
  assert.equal(withHistory.tiles[0].id, "plugin:beta");
});

test("an empty query produces no hit tiles", () => {
  const result = search(catalog([plugin("alpha", "Alpha")]), "   ");

  assert.equal(result.tiles.length, 0);
  assert.equal(result.total, 0);
});
