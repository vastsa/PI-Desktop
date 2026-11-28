import assert from "node:assert/strict";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

test("window zoom keeps the titlebar draggable and its buttons clickable", async () => {
  const styles = await loadStyles();
  assert.match(styles, /\.main-titlebar\s*\{[^}]*?app-region:\s*drag;/);
  assert.match(styles, /\.conversation-topbar\s*\{[^}]*?app-region:\s*drag;/);
  assert.match(styles, /\.conversation-topbar \.ct-title-trigger\s*\{[^}]*?app-region:\s*no-drag;/);
  assert.match(styles, /\.app-work-panel-toggle\s*\{[^}]*?app-region:\s*no-drag;/);
  const zoomDragOverride = /\[data-window-maximized[^\]]*\][^{]*\{[^}]*?app-region:\s*no-drag/;
  assert.equal(zoomDragOverride.test(styles), false, "zoom must preserve native drag regions");
});
