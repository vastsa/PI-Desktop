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

test("the closed trigger and search use the localized system-default label", () => {
  assert.match(rowSource, /const defaultLabel = t\("settings\.fontSystemDefault"\)/);
  assert.match(
    rowSource,
    /selectedOption\?\.group === "default" \|\| selectedValue === ""/,
  );
  assert.match(
    rowSource,
    /option\.group === "default"[\s\S]*?`\$\{defaultLabel\} \$\{option\.label\}`\.toLowerCase\(\)/,
  );
});

test("the font trigger hugs the current label like language and theme", () => {
  assert.match(
    styles,
    /\.settings-language-anchor,\s*\.settings-theme-anchor,\s*\.settings-menu-select-anchor,\s*\.settings-font\s*\{[^}]*width:\s*max-content/s,
  );
  assert.match(
    styles,
    /\.settings-language-trigger,\s*\.settings-theme-trigger,\s*\.settings-menu-select-trigger,\s*\.settings-font-trigger\s*\{[^}]*width:\s*max-content/s,
  );
  assert.match(
    styles,
    /\.settings-language-trigger-label,\s*\.settings-theme-trigger-label,\s*\.settings-menu-select-trigger-label,\s*\.settings-font-trigger-label\s*\{[^}]*flex:\s*0 1 auto/s,
  );
  assert.doesNotMatch(styles, /\.settings-font-trigger\s*\{[^}]*min-width:\s*200px;/s);
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

test("the picker has no bundled group, license badge, or fontBundled copy", () => {
  assert.doesNotMatch(rowSource, /group === "bundled"/);
  assert.doesNotMatch(rowSource, /settings\.fontBundled/);
  assert.doesNotMatch(rowSource, /settings-font-item-license/);
  assert.doesNotMatch(rowSource, /option\.license/);
  assert.doesNotMatch(styles, /\.settings-font-item-license\s*\{/);
});
