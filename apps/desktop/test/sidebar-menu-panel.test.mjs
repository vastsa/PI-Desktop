import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { placeSidebarSubmenu } from "../src/lib/sidebar-menu.ts";
const panelSource = await readFile(
  new URL("../src/components/SidebarMenuPanel.tsx", import.meta.url),
  "utf8",
);

test("the panel renders every item kind with its own accessible role", () => {
  assert.match(panelSource, /role="menuitem"[\s\S]*?data-action=\{item\.id\}/);
  assert.match(panelSource, /role="menuitemradio"/);
  assert.match(panelSource, /role="menuitemcheckbox"/);
  assert.match(panelSource, /assert|aria-checked=\{item\.checked\}|aria-checked=\{option\.selected\}/);
  assert.match(panelSource, /className="sidebar-menu-separator"|role="separator"/);
  assert.match(panelSource, /className="sidebar-menu-section"/);
  assert.match(panelSource, /className="sidebar-menu-hint"/);
  assert.match(panelSource, /className="sidebar-menu-note"/);
  /* A caption is a label, not a row: it must never become a menuitem. */
  assert.doesNotMatch(panelSource, /<button[^>]*data-sidebar-menu-section/);
  assert.match(panelSource, /aria-label=\{content\.label\}/);
});

test("keyboard navigation walks the rows the menu can actually run", () => {
  assert.match(
    panelSource,
    /\[role="menuitem"\]:not\(:disabled\), \[role="menuitemradio"\]:not\(:disabled\), \[role="menuitemcheckbox"\]:not\(:disabled\)/,
  );
  assert.match(panelSource, /ArrowDown/);
  assert.match(panelSource, /ArrowUp/);
  assert.match(panelSource, /Home/);
  assert.match(panelSource, /End/);
  assert.match(panelSource, /event\.key === "Escape"[\s\S]*?onClose\(\)/);
});

test("submenu trigger advertises its expanded state and opens on hover or click", () => {
  assert.match(panelSource, /data-submenu-trigger=\{item\.id\}/);
  assert.match(panelSource, /aria-haspopup="menu"/);
  assert.match(panelSource, /aria-expanded=\{expanded\}/);
  assert.match(panelSource, /event\.pointerType === "mouse"\) openSubmenu\(item\.id, false\)/);
  assert.match(panelSource, /onClick=\{\(event\) => openSubmenu\(item\.id, event\.detail === 0\)\}/);
});

test("submenu keyboard entry and return preserve focus", () => {
  assert.match(panelSource, /event\.key === "ArrowRight"/);
  assert.match(panelSource, /event\.key === "ArrowLeft" && isSubmenu/);
  assert.match(panelSource, /if \(isSubmenu\) closeSubmenu\(true\)/);
  assert.match(panelSource, /trigger\?\.focus\(\)/);
});

test("submenu flips left and clamps against viewport edges", () => {
  assert.deepEqual(
    placeSidebarSubmenu(
      { top: 100, left: 200, right: 224 },
      { width: 180, height: 120 },
      { width: 800, height: 600 },
    ),
    { top: 100, left: 224 },
  );
  assert.deepEqual(
    placeSidebarSubmenu(
      { top: 590, left: 740, right: 764 },
      { width: 180, height: 120 },
      { width: 800, height: 600 },
    ),
    { top: 472, left: 560 },
  );
});

test("the submenu is portaled out of the scrollable root menu (#1896)", () => {
  // As a DOM child of the fixed, scrollable root menu the child panel is only
  // viewport-anchored while nothing on the menu creates a containing block: a
  // theme's backdrop-filter (or a transform/contain) offsets it by the menu's
  // own position and stretches the menu's scroll area. Portaling it to the
  // body removes that dependency for good.
  assert.match(panelSource, /openSubmenuItem\s*\n?\s*\?\s*portalToBody\(/);
  assert.match(panelSource, /import \{ portalToBody \} from "\.\.\/lib\/portal-visibility"/);
  const portalCall = panelSource.slice(
    panelSource.indexOf("portalToBody("),
    panelSource.indexOf("className=\"sidebar-row-menu sidebar-submenu\""),
  );
  assert.match(portalCall, /ref=\{submenuRef\}/);
});

test("pointer travel between the menu and its portal keeps the submenu open", () => {
  // Both sides must recognize the other's element: the root menu no longer
  // contains the child panel, so moving onto it would otherwise close it.
  assert.match(
    panelSource,
    /event\.currentTarget\.contains\(related\) \|\| submenuRef\.current\?\.contains\(related\)/,
  );
  assert.match(panelSource, /onPointerLeave=\{handleSubmenuPointerLeave\}/);
  assert.match(
    panelSource,
    /submenuRef\.current\?\.contains\(related\) \|\| rootMenuRef\.current\?\.contains\(related\)/,
  );
});

test("the child panel follows its trigger through menu scroll and growth", () => {
  assert.match(panelSource, /root\?\.addEventListener\("scroll", reposition/);
  assert.match(panelSource, /observer\.observe\(root\)/);
  assert.match(panelSource, /root\?\.removeEventListener\("scroll", reposition\)/);
});

/*
  The new menu vocabulary is product copy, so every shipped locale carries it;
  a missing key would silently fall back to English.
*/
test("every locale ships the sidebar menu keys", async () => {
  const { catalogs } = await import("@pi-desktop/i18n");
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const nav = catalog.nav ?? {};
    assert.equal(typeof nav.dangerZone, "string", `${locale}: nav.dangerZone`);
    assert.equal(typeof nav.viewOptions, "string", `${locale}: nav.viewOptions`);
    assert.equal(typeof nav.copySessionPath, "string", `${locale}: nav.copySessionPath`);
    assert.equal(typeof nav.batchSelectionHint, "string", `${locale}: nav.batchSelectionHint`);
    assert.equal(typeof catalog.project?.copyName, "string", `${locale}: project.copyName`);
    assert.equal(typeof catalog.project?.copyPath, "string", `${locale}: project.copyPath`);
    assert.equal(
      typeof catalog.worktree?.menu?.group,
      "string",
      `${locale}: worktree.menu.group`,
    );
  }
});
