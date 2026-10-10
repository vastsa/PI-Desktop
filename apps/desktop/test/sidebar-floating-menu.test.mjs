import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  clampSidebarFloatingMenuTop,
  SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
  SIDEBAR_MENU_VIEWPORT_PADDING,
} = await import("../src/lib/sidebar-floating-menu.ts");

test("sidebar floating menu stays within the viewport at the lower edge", () => {
  const top = clampSidebarFloatingMenuTop(850, 900);

  assert.equal(top, 900 - SIDEBAR_FLOATING_MENU_MAX_HEIGHT - SIDEBAR_MENU_VIEWPORT_PADDING);
  assert.equal(top + SIDEBAR_FLOATING_MENU_MAX_HEIGHT + SIDEBAR_MENU_VIEWPORT_PADDING, 900);
});

test("sidebar floating menu keeps its anchor position when there is room", () => {
  assert.equal(clampSidebarFloatingMenuTop(240, 900), 240);
});

test("sidebar floating menu uses viewport padding in a short window", () => {
  assert.equal(clampSidebarFloatingMenuTop(240, 300), SIDEBAR_MENU_VIEWPORT_PADDING);
});
