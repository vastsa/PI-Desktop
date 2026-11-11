import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { shouldMountTranscriptContent, hasStatefulTranscriptContent } = await import("../src/lib/transcript-content-window.ts");

test("structured Markdown retains lazy diagrams, plugin fences and table preview state", () => {
  for (const source of [
    "```mermaid\ngraph TD; A-->B\n```", "~~~custom-plugin\ninteractive\n~~~",
    "Name | Value\n--- | ---\nA | B", "| Name | Value |\n| :--- | ---: |\n| A | B |",
  ]) assert.equal(hasStatefulTranscriptContent(source), true, source);
  for (const source of ["A paragraph with **bold** and `inline code`.", "A | B is ordinary prose."])
    assert.equal(hasStatefulTranscriptContent(source), false, source);
});

const sample = (changes = {}) => ({
  top: 10000, bottom: 10200, viewportHeight: 600,
  measuredHeight: 200, measuredWidth: 800, width: 800,
  mounted: true, protected: false, ...changes,
});

test("measured content is released on both sides of the viewport", () => {
  assert.equal(shouldMountTranscriptContent(sample()), false);
  assert.equal(shouldMountTranscriptContent(sample({ top: -10000, bottom: -9800 })), false);
});

test("enter and exit buffers prevent boundary mount oscillation", () => {
  assert.equal(shouldMountTranscriptContent(sample({ top: 2500, bottom: 2700 })), true);
  assert.equal(shouldMountTranscriptContent(sample({ top: 2500, bottom: 2700, mounted: false })), false);
  assert.equal(shouldMountTranscriptContent(sample({ top: 2300, bottom: 2500, mounted: false })), true);
  assert.equal(shouldMountTranscriptContent(sample({ top: -1900, bottom: -1700, mounted: false })), true);
});

test("a long answer intersecting the viewport is never evicted by its start position", () => {
  assert.equal(shouldMountTranscriptContent(sample({ top: -10000, bottom: 200 })), true);
});

test("unknown, resized, or invalid geometry cannot become a stale placeholder", () => {
  for (const changes of [
    { measuredHeight: null }, { measuredWidth: null }, { width: 700 },
    { measuredHeight: NaN }, { measuredHeight: -1 }, { measuredWidth: Infinity },
    { width: 0 }, { top: NaN }, { bottom: Infinity }, { top: 10201 },
  ]) assert.equal(shouldMountTranscriptContent(sample(changes)), true, JSON.stringify(changes));
});

test("streaming, focused, selected, and navigation-owned content stays mounted", () => {
  assert.equal(shouldMountTranscriptContent(sample({ protected: true })), true);
});

test("a hidden retained pane does not evict its existing contents", () => {
  assert.equal(shouldMountTranscriptContent(sample({ viewportHeight: 0 })), true);
  assert.equal(shouldMountTranscriptContent(sample({ viewportHeight: 0, mounted: false })), false);
});

test("traversing a measured transcript does not accumulate mounted content", () => {
  let mounted = Array.from({ length: 1000 }, () => true);
  for (const scrollTop of [0, 12000, 60000, 120000, 180000, 60000, 0]) {
    mounted = mounted.map((previous, index) => shouldMountTranscriptContent(sample({
      top: index * 200 - scrollTop, bottom: (index + 1) * 200 - scrollTop,
      mounted: previous,
    })));
    assert(mounted.filter(Boolean).length <= 34);
    const visible = Math.floor(scrollTop / 200);
    assert(mounted.slice(visible, visible + 3).every(Boolean));
  }
});
