import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFontListLayout,
  FONT_GROUP_ROW_HEIGHT,
  FONT_LIST_OVERSCAN,
  FONT_OPTION_ROW_HEIGHT,
  visibleRowRange,
} from "../src/lib/font-list.ts";

const option = (label, group) => ({
  value: `'${label}', sans-serif`,
  label,
  family: label,
  group,
});

const groupName = (group) => `[${group}]`;

test("buildFontListLayout emits a group row before each group and fixed heights", () => {
  const options = [
    option("Arial", "system"),
    option("PingFang SC", "system"),
  ];
  const layout = buildFontListLayout(options, groupName);
  assert.deepEqual(
    layout.rows.map((row) =>
      row.kind === "group" ? `group:${row.label}` : `option:${row.option.label}`,
    ),
    ["group:[system]", "option:Arial", "option:PingFang SC"],
  );
  assert.deepEqual(layout.heights, [
    FONT_GROUP_ROW_HEIGHT,
    FONT_OPTION_ROW_HEIGHT,
    FONT_OPTION_ROW_HEIGHT,
  ]);
  assert.deepEqual(layout.optionRowIndex, [1, 2]);
  assert.equal(
    layout.totalHeight,
    FONT_GROUP_ROW_HEIGHT + 2 * FONT_OPTION_ROW_HEIGHT,
  );
});

test("buildFontListLayout places group rows only at group boundaries", () => {
  const options = [
    option("System default", "default"),
    option("Geist", "bundled"),
    option("Arial", "system"),
    option("Verdana", "system"),
  ];
  const layout = buildFontListLayout(options, groupName);
  assert.deepEqual(
    layout.rows
      .filter((row) => row.kind === "group")
      .map((row) => row.label),
    ["[default]", "[bundled]", "[system]"],
  );
  assert.equal(layout.rows.length, 3 + 4);
  assert.deepEqual(layout.optionRowIndex, [1, 3, 5, 6]);
  assert.equal(
    layout.offsets[layout.optionRowIndex[2]],
    FONT_GROUP_ROW_HEIGHT * 3 + FONT_OPTION_ROW_HEIGHT * 2,
  );
});

test("visibleRowRange returns an empty window for an empty layout", () => {
  const layout = buildFontListLayout([], groupName);
  assert.deepEqual(visibleRowRange(layout, 0, 320), { start: 0, end: 0 });
});

test("visibleRowRange renders only the viewport slice plus overscan", () => {
  const options = Array.from({ length: 200 }, (_, index) =>
    option(`Font ${index}`, "system"),
  );
  const layout = buildFontListLayout(options, groupName);
  const viewport = 320;
  const scrollTop = layout.offsets[100];
  const { start, end } = visibleRowRange(layout, scrollTop, viewport);
  assert.ok(start > 0);
  assert.ok(end < layout.rows.length);
  assert.equal(
    end - start,
    2 * FONT_LIST_OVERSCAN + Math.ceil(viewport / FONT_OPTION_ROW_HEIGHT) + 1,
  );
});

test("visibleRowRange clamps to the first and last rows", () => {
  const options = Array.from({ length: 40 }, (_, index) =>
    option(`Font ${index}`, "system"),
  );
  const layout = buildFontListLayout(options, groupName);
  assert.deepEqual(visibleRowRange(layout, 0, 320), { start: 0, end: 20 });
  const last = visibleRowRange(layout, layout.totalHeight, 320);
  assert.equal(last.start, layout.rows.length - FONT_LIST_OVERSCAN);
  assert.equal(last.end, layout.rows.length);
});
