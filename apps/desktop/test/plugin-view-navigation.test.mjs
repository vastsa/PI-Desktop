import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { detachPluginViewOnRendererReload } = await import(
  "../electron/main/plugin-view-navigation.ts"
);
const windowSource = readFileSync(
  new URL("../electron/main/bootstrap/window.ts", import.meta.url),
  "utf8",
);
const viewHostSource = readFileSync(
  new URL("../electron/main/plugin-view-host.ts", import.meta.url),
  "utf8",
);

test("only full main-frame navigation detaches the visible plugin view", () => {
  let listener;
  const webContents = {
    on(event, callback) {
      assert.equal(event, "did-start-navigation");
      listener = callback;
      return this;
    },
  };
  let detachCount = 0;

  detachPluginViewOnRendererReload(webContents, () => {
    detachCount += 1;
  });

  listener({}, "file:///index.html#section", true, true);
  listener({}, "https://plugin.invalid/frame", false, false);
  assert.equal(detachCount, 0);

  listener({}, "file:///index.html", false, true);
  assert.equal(detachCount, 1);
});

test("window reload wiring detaches the cached view without closing its page", () => {
  assert.match(
    windowSource,
    /detachPluginViewOnRendererReload\(\s*window\.webContents,\s*\(\) => pluginViews\.hideVisibleView\(\),?\s*\)/,
  );

  const hideMethod = viewHostSource.match(
    /hideVisibleView\(\): void \{([\s\S]*?)\n  \}/,
  )?.[1];
  assert.match(hideMethod ?? "", /this\.detachVisible\(\)/);
  assert.doesNotMatch(hideMethod ?? "", /\.close\(/);

  const detachMethod = viewHostSource.match(
    /private detachVisible\(\): void \{([\s\S]*?)\n  \}/,
  )?.[1];
  assert.match(detachMethod ?? "", /removeChildView\(entry\.view\)/);
  assert.doesNotMatch(detachMethod ?? "", /webContents\.close\(/);
});
