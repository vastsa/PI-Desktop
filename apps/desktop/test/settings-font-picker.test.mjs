import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const rowSource = await readFile(
  new URL("../src/components/settings/FontFamilyRow.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("font picker menu portals to the body so the settings card cannot clip it", () => {
  assert.match(rowSource, /createPortal\(/);
  assert.match(rowSource, /document\.body/);
  assert.match(styles, /\.settings-font-menu\s*\{[^}]*position:\s*fixed;/s);
  assert.match(styles, /\.settings-font-menu\.is-open\s*\{/);
  assert.doesNotMatch(
    styles,
    /\.settings-font-menu\s*\{[^}]*position:\s*absolute;/s,
  );
});

test("selecting System default persists an empty stack so the override clears", () => {
  assert.match(rowSource, /saveSettings\(value \? \{ fontFamily: value \} : \{ fontFamily: "" \}\)/);
  assert.doesNotMatch(rowSource, /fontFamily: undefined/);
});

test("font list windows the rows so only the visible slice is in the DOM", () => {
  assert.match(rowSource, /visibleRowRange\(layout, scrollTop/);
  assert.match(rowSource, /layout\.rows\.slice\(start, end\)/);
  assert.match(rowSource, /position: "absolute"/);
  assert.match(rowSource, /height: FONT_OPTION_ROW_HEIGHT/);
  assert.match(styles, /\.settings-font-list\s*\{[^}]*position:\s*relative;/s);
  assert.match(styles, /\.settings-font-list\s*\{[^}]*overflow-y:\s*auto;/s);
});

test("font list never scrolls horizontally", () => {
  assert.match(styles, /\.settings-font-list\s*\{[^}]*overflow-x:\s*hidden;/s);
  // Rows are absolutely positioned with inline left/right insets; a width on
  // them would over-constrain the box, drop `right`, and overflow the list.
  assert.doesNotMatch(styles, /\.settings-font-item\s*\{[^}]*width:\s*100%;/s);
  assert.match(rowSource, /left: 6,\s*right: 6,/s);
});

test("highlight scrolling uses the layout offsets instead of scrollIntoView", () => {
  assert.match(rowSource, /layout\.offsets\[rowIndex\]/);
  assert.match(rowSource, /list\.scrollTop = top \+ height - viewport/);
  assert.doesNotMatch(rowSource, /listRef\.current\?\.querySelector/);
});

test("menu repositioning ignores scrolls inside the font list", () => {
  assert.match(
    rowSource,
    /menuRef\.current\?\.contains\(target\)/,
  );
});
