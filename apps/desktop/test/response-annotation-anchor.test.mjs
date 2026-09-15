import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveAnnotationOffsets, placeAnnotationBadges, captureAnnotationAnchor, annotationRange } = await import("../src/lib/response-annotation-anchor.ts");
import { annotationEditorFor, applyAnnotationComment, responseAnnotationPrompt } from "../src/lib/response-annotations.ts";

test("the second occurrence stays the second occurrence; ambiguous stale anchors never guess", () => {
  const anchor = { start: 4, end: 7, exact: "foo" };
  assert.deepEqual(resolveAnnotationOffsets("foo foo", anchor), { start: 4, end: 7 });
  assert.equal(resolveAnnotationOffsets("x foo foo", anchor), null);
  assert.deepEqual(resolveAnnotationOffsets("prefix foo", anchor), { start: 7, end: 10 });
  assert.equal(resolveAnnotationOffsets("gone", anchor), null);
});

test("capture and resolution use offsets across split text nodes and never modify their text", () => {
  const nodes = ["hello ", "world", " world"].map((data) => ({
    data, textContent: data, length: data.length,
    parentElement: { closest: (selector) => selector === ".prose-chat" ? {} : null },
  }));
  const range = {
    startContainer: nodes[1], startOffset: 1, endContainer: nodes[2], endOffset: 4,
    cloneRange() { return this; }, intersectsNode: (node) => node !== nodes[0],
  };
  const recovered = {};
  const row = { contains: () => true, ownerDocument: {
    createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] }; },
    createRange: () => ({
      setStart: (node, offset) => { recovered.start = [nodes.indexOf(node), offset]; },
      setEnd: (node, offset) => { recovered.end = [nodes.indexOf(node), offset]; },
    }),
  } };
  const anchor = captureAnnotationAnchor(row, range);
  assert.deepEqual(anchor, { start: 7, end: 15, exact: "orld wor" });
  assert.ok(annotationRange(row, anchor));
  assert.deepEqual(recovered, { start: [1, 1], end: [2, 4] });
  assert.equal(nodes.map((node) => node.data).join(""), "hello world world");
});

test("same words at distinct positions or in different answers keep separate numbers", () => {
  const anchor = { start: 0, end: 3, exact: "foo" };
  const first = annotationEditorFor([], { sessionId: "s", messageId: "m1", text: "foo", anchor });
  let annotations = applyAnnotationComment([], first, "first", "a1", 1);
  const second = annotationEditorFor(annotations, { sessionId: "s", messageId: "m1", text: "foo", anchor: { ...anchor, start: 4, end: 7 } });
  assert.equal(second.annotationId, null);
  annotations = applyAnnotationComment(annotations, second, "second", "a2", 2);
  const third = annotationEditorFor(annotations, { sessionId: "s", messageId: "m2", text: "foo", anchor });
  annotations = applyAnnotationComment(annotations, third, "third", "a3", 3);
  assert.deepEqual(annotations.map((item) => item.id), ["a1", "a2", "a3"]);
  assert.equal(annotationEditorFor(annotations, { sessionId: "s", messageId: "m1", text: "foo", anchor }).annotationId, "a1");
  const prompt = responseAnnotationPrompt("review", annotations);
  assert.ok(prompt.includes('"annotation":"second"'));
  assert.ok(!prompt.includes('"anchor"'));
  assert.ok(!prompt.includes('"exact"'));
});

test("whole-answer and selected-answer entry points reopen one annotation in either order", () => {
  const input = { sessionId: "s", messageId: "m1", text: "whole answer" };
  const anchor = { start: 0, end: 12, exact: "whole answer" };
  for (const firstAnchor of [undefined, anchor]) {
    const first = annotationEditorFor([], { ...input, anchor: firstAnchor });
    const annotations = applyAnnotationComment([], first, "keep", "a1", 1);
    const secondInput = { ...input, anchor: firstAnchor ? undefined : anchor };
    assert.equal(annotationEditorFor(annotations, secondInput).annotationId, "a1");
    // A stale create request must not insert the same answer under a new number.
    assert.equal(applyAnnotationComment(annotations,
      { ...secondInput, annotationId: null, comment: "" }, "new", "a2", 2), null);
  }
});

test("badges sharing a line stack visibly and never escape the transcript band", () => {
  const placed = placeAnnotationBadges([{ top: 12, id: "2" }, { top: 10, id: "1" }, { top: 12, id: "3" }], 0, 75);
  assert.deepEqual(placed, [{ top: 10, id: "1" }, { top: 35, id: "2" }]);
});
