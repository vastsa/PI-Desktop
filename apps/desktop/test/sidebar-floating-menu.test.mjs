import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  placeSidebarFloatingMenuTop,
  SIDEBAR_MENU_VIEWPORT_PADDING,
} = await import("../src/lib/sidebar-floating-menu.ts");

test("sidebar floating menu opens above a bottom-edge project row", () => {
  const top = placeSidebarFloatingMenuTop(
    { top: 720, bottom: 752 },
    200,
    900,
  );

  assert.equal(top, 720 - 200 - 4);
});

test("sidebar floating menu stays below its anchor when the actual height fits", () => {
  const top = placeSidebarFloatingMenuTop(
    { top: 480, bottom: 512 },
    200,
    900,
  );

  assert.equal(top, 512 + 4);
});

test("sidebar floating menu opens above a pointer near the viewport bottom", () => {
  const pointerY = 840;
  const menuHeight = 220;
  const top = placeSidebarFloatingMenuTop(
    { top: pointerY, bottom: pointerY },
    menuHeight,
    900,
  );

  assert.equal(top, pointerY - menuHeight - 4);
});

test("sidebar floating menu stays within viewport padding in a short window", () => {
  const viewportHeight = 300;
  const top = placeSidebarFloatingMenuTop(
    { top: 260, bottom: 280 },
    500,
    viewportHeight,
  );

  assert.equal(top, SIDEBAR_MENU_VIEWPORT_PADDING);
  assert.equal(
    top + viewportHeight - 2 * SIDEBAR_MENU_VIEWPORT_PADDING,
    viewportHeight - SIDEBAR_MENU_VIEWPORT_PADDING,
  );
});
