import assert from "node:assert/strict";
import test from "node:test";
import { cardsFromEditor, editorChanges } from "../src/components/project-memory-editor-model.ts";

const original = {
  owner: "group:g",
  memory: { content: "Original\n\nSecond", entries: [
    { id: "first", title: "First", content: "Original" },
    { id: "second", title: "Second", content: "Second" },
  ], updatedAt: 1 },
  autoRecordEnabled: true,
};

test("one editor exposes a single stable list and stages edits together", () => {
  const draft = cardsFromEditor(original);
  assert.deepEqual(draft.map(({ id }) => id), ["first", "second"]);
  const updated = draft.map((entry) => entry.id === "first" ? { ...entry, content: "Revised" } : entry);
  updated.push({ id: "third", title: "Third", content: "Added" });
  assert.deepEqual(editorChanges(original, updated), { entries: [
    { id: "first", title: "First", content: "Revised" },
    original.memory.entries[1],
    { id: "third", title: "Third", content: "Added" },
  ] });
  assert.deepEqual(original.memory.entries[0], { id: "first", title: "First", content: "Original" });
});

test("deleting one entry leaves the other untouched", () => {
  assert.deepEqual(editorChanges(original, cardsFromEditor(original).slice(1)), {
    entries: [original.memory.entries[1]],
  });
});

test("blank bodies are excluded and unchanged editor stays clean", () => {
  const draft = cardsFromEditor(original);
  draft.push({ id: "new", title: "Draft", content: " " });
  assert.deepEqual(editorChanges(original, draft), { entries: [...original.memory.entries] });
  assert.equal(editorChanges(original, cardsFromEditor(original)), null);
  assert.deepEqual(editorChanges(original, draft.map((entry) => ({ ...entry, content: "  " }))), {
    entries: [],
  });
});

test("legacy content opens as a single editable entry without rewriting its baseline", () => {
  const legacy = { owner: "project:a", memory: { content: "  Remember this  ", updatedAt: 4 }, autoRecordEnabled: false };
  const cards = cardsFromEditor(legacy);
  assert.deepEqual(cards, [{ id: "legacy-project-memory", title: "", content: "Remember this" }]);
  assert.equal(editorChanges(legacy, cards), null);
  assert.deepEqual(editorChanges(legacy, [{ ...cards[0], content: "Updated" }]), {
    entries: [{ id: "legacy-project-memory", title: "", content: "Updated" }],
  });
  assert.equal(legacy.memory.content, "  Remember this  ");
});
