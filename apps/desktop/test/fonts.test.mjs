import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFontOptions,
  cssFamilyForName,
  readableFontFamily,
} from "../src/lib/fonts.ts";

const CJK_FALLBACK = `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;

test("cssFamilyForName quotes names and escapes single quotes", () => {
  assert.equal(cssFamilyForName("PingFang SC"), "'PingFang SC'");
  assert.equal(cssFamilyForName("O'Brien"), "'O\\'Brien'");
});

test("readableFontFamily extracts the first family without quotes", () => {
  assert.equal(readableFontFamily(`"Geist", "Noto Sans SC", sans-serif`), "Geist");
  assert.equal(readableFontFamily("'Fira Code', monospace"), "Fira Code");
  assert.equal(readableFontFamily("Arial"), "Arial");
});

test("buildFontOptions orders the default before system fonts", () => {
  const options = buildFontOptions(["PingFang SC", "Arial"], undefined);
  assert.equal(options[0].value, "");
  assert.equal(options[0].group, "default");
  assert.deepEqual(
    options.map((option) => option.group),
    ["default", "system", "system"],
  );
  const system = options.filter((option) => option.group === "system");
  assert.deepEqual(system.map((option) => option.label), ["PingFang SC", "Arial"]);
});

test("the app offers no bundled family", () => {
  const options = buildFontOptions(["Arial"], undefined);
  assert.ok(options.every((option) => option.group !== "bundled"));
});

test("every offered stack ends in the system CJK fallback tier", () => {
  const options = buildFontOptions(["Arial"], undefined);
  for (const option of options.slice(1)) {
    assert.ok(
      option.value.endsWith(CJK_FALLBACK),
      `${option.label} does not end in the CJK fallback tier`,
    );
  }
});

test("buildFontOptions keeps a stored selection that is no longer known", () => {
  const stored = `"Removed Font", "Noto Sans SC", sans-serif`;
  const options = buildFontOptions([], stored);
  assert.equal(options[0].value, stored);
  assert.equal(options[0].group, "custom");
  assert.equal(options[0].label, "Removed Font");
});

test("buildFontOptions keeps a stack naming a formerly bundled family", () => {
  const stored = `"Geist", ${CJK_FALLBACK}`;
  const options = buildFontOptions(["PingFang SC"], stored);
  assert.equal(options[0].value, stored);
  assert.equal(options[0].group, "custom");
  assert.equal(options[0].label, "Geist");
});

test("buildFontOptions treats an empty stored stack as the system default", () => {
  const options = buildFontOptions(["PingFang SC"], "");
  assert.equal(options[0].value, "");
  assert.equal(options[0].group, "default");
  assert.ok(options.every((option) => option.group !== "custom"));
});
