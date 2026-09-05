import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLED_FONTS,
  buildFontOptions,
  cssFamilyForName,
  readableFontFamily,
} from "../src/lib/fonts.ts";

test("cssFamilyForName quotes names and escapes single quotes", () => {
  assert.equal(cssFamilyForName("PingFang SC"), "'PingFang SC'");
  assert.equal(cssFamilyForName("O'Brien"), "'O\\'Brien'");
});

test("readableFontFamily extracts the first family without quotes", () => {
  assert.equal(readableFontFamily(`"Geist", "Noto Sans SC", sans-serif`), "Geist");
  assert.equal(readableFontFamily("'Fira Code', monospace"), "Fira Code");
  assert.equal(readableFontFamily("Arial"), "Arial");
});

test("bundled fonts are OFL-licensed and keep CJK fallbacks", () => {
  for (const font of BUNDLED_FONTS) {
    assert.match(font.license, /OFL/);
    assert.ok(font.stack.startsWith(`"${font.family}"`));
    assert.match(font.stack, /Noto Sans SC|PingFang SC|Microsoft YaHei/);
  }
});

test("buildFontOptions orders default, bundled, then system fonts", () => {
  const options = buildFontOptions(["PingFang SC", "Arial"], undefined);
  assert.equal(options[0].value, "");
  assert.equal(options[0].group, "default");
  const bundled = options.filter((option) => option.group === "bundled");
  assert.equal(bundled.length, BUNDLED_FONTS.length);
  const system = options.filter((option) => option.group === "system");
  assert.deepEqual(system.map((option) => option.label), ["PingFang SC", "Arial"]);
});

test("buildFontOptions keeps a stored selection that is no longer known", () => {
  const stored = `"Removed Font", "Noto Sans SC", sans-serif`;
  const options = buildFontOptions([], stored);
  assert.equal(options[0].value, stored);
  assert.equal(options[0].group, "custom");
  assert.equal(options[0].label, "Removed Font");
});

test("buildFontOptions treats an empty stored stack as the system default", () => {
  const options = buildFontOptions(["PingFang SC"], "");
  assert.equal(options[0].value, "");
  assert.equal(options[0].group, "default");
  assert.ok(options.every((option) => option.group !== "custom"));
});

test("buildFontOptions matches a bundled selection by its stack", () => {
  const geist = BUNDLED_FONTS.find((font) => font.id === "geist");
  const options = buildFontOptions([], geist.stack);
  const match = options.find((option) => option.value === geist.stack);
  assert.ok(match);
  assert.equal(match.group, "bundled");
});
