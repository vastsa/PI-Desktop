import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * Plugin marks in the composer draft (`docs/plugin-plan/ui/composer/`,
 * `docs/plugin-plan/render/draft/`): a mark is a chip that shows its label
 * and sends its text, one draft shows at most eight, and every further mark
 * joins one host fold chip. Marks carry no path, so nothing path-shaped
 * (labels, the workspace switch, the text-expand action) applies to them.
 */
const { PLUGIN_DRAFT_MAX_MARKS } = await import("@pi-desktop/plugin-sdk");
const { serializeComposerFileReferences } = await import("@pi-desktop/shared");
const { createFileReference, isEditableTextReference, isPluginMark } = await import(
  "../src/features/chat/composer/editor.ts"
);
const { createPluginMark, foldLabel, liveChipReferences, placePluginMark } = await import(
  "../src/features/chat/composer/plugins/plugin-marks.ts"
);
const {
  draftFileReference,
  sameDraftFileReference,
  snapshotComposerDraft,
  resetComposerDraftCache,
} = await import("../src/lib/composer-draft-cache.ts");

const SESSION = "session-1";
const mark = (n, pluginId = "demo.lab") => ({ pluginId, label: `#${n}`, send: `Issue ${n}` });

/** Accept `count` marks into an empty draft the way the composer does. */
function acceptMarks(count, pluginId) {
  let references = [];
  let text = "";
  for (let n = 1; n <= count; n += 1) {
    const placed = placePluginMark(references, text, mark(n, pluginId), SESSION);
    references = placed.references;
    if (placed.token) text += `${placed.token} `;
  }
  return { references, text };
}

test("a mark shows its label as given and sends its text in place", () => {
  const created = createPluginMark({ pluginId: "demo.lab", label: "src/a.ts", send: "S" }, SESSION);
  assert.equal(created.name, "src/a.ts", "a label is never shortened like a path");
  assert.equal(created.path, "");
  assert.equal(created.sessionId, SESSION);
  assert.equal(created.token.length, 1);
  assert.deepEqual(created.plugin, { kind: "mark", pluginId: "demo.lab", send: "S" });
  assert.equal(isPluginMark(created), true);
  assert.equal(isEditableTextReference(created), false);

  const labelled = createPluginMark({ pluginId: "demo.lab", label: "notes.txt", send: "S" }, SESSION);
  assert.equal(isEditableTextReference(labelled), false, "a .txt label is no text file");
  assert.equal(
    serializeComposerFileReferences(`look ${created.token}now`, [created]),
    "look S now",
  );

  const file = createFileReference("/tmp/a/notes.txt", undefined, SESSION);
  assert.equal(file.name, "notes.txt");
  assert.equal(isPluginMark(file), false);
  const attachment = createFileReference("/tmp/a/b.txt", "b.txt", SESSION, {
    plugin: { kind: "attachment", pluginId: "demo.lab", id: "att-1", size: 3 },
  });
  assert.equal(isPluginMark(attachment), false, "a plugin's attachment is a file");
});

test("up to eight marks are chips of their own; the ninth opens the fold", () => {
  const { references, text } = acceptMarks(PLUGIN_DRAFT_MAX_MARKS + 1);
  const live = liveChipReferences(references, text);
  assert.equal(live.length, PLUGIN_DRAFT_MAX_MARKS + 1);
  assert.deepEqual(
    live.slice(0, PLUGIN_DRAFT_MAX_MARKS).map((reference) => reference.plugin.kind),
    Array(PLUGIN_DRAFT_MAX_MARKS).fill("mark"),
  );
  const fold = live.at(-1);
  assert.equal(fold.name, foldLabel(1));
  assert.deepEqual(fold.plugin, { kind: "fold", pluginId: "demo.lab", send: "Issue 9", count: 1 });
});

test("further marks join the one fold, which keeps every text they send", () => {
  const { references, text } = acceptMarks(PLUGIN_DRAFT_MAX_MARKS + 3);
  const live = liveChipReferences(references, text);
  assert.equal(live.length, PLUGIN_DRAFT_MAX_MARKS + 1, "one chip holds the overflow");
  const fold = live.at(-1);
  assert.equal(fold.name, "⧉ +3");
  assert.equal(fold.plugin.count, 3);
  assert.equal(fold.plugin.send, "Issue 9 Issue 10 Issue 11");
  const sent = serializeComposerFileReferences(text, references);
  for (let n = 1; n <= PLUGIN_DRAFT_MAX_MARKS + 3; n += 1) {
    assert.match(sent, new RegExp(`Issue ${n}\\b`));
  }
});

test("the limit counts marks of every plugin, and only chips still in the text", () => {
  let { references, text } = acceptMarks(PLUGIN_DRAFT_MAX_MARKS - 1, "demo.lab");
  let placed = placePluginMark(references, text, mark(99, "demo.other"), SESSION);
  assert.equal(placed.references.at(-1).plugin.kind, "mark", "the eighth is a chip");
  references = placed.references;
  text += placed.token;
  placed = placePluginMark(references, text, mark(100, "demo.other"), SESSION);
  assert.equal(placed.references.at(-1).plugin.kind, "fold");
  assert.equal(placed.references.at(-1).plugin.pluginId, "demo.other", "the fold names its first plugin");

  // A chip the user deleted no longer counts, even with its reference around.
  const withoutFirst = text.replace(references[0].token, "");
  placed = placePluginMark(references, withoutFirst, mark(101), SESSION);
  assert.equal(placed.references.at(-1).plugin.kind, "mark");
});

test("draft snapshots keep a reference's plugin part and compare it", () => {
  resetComposerDraftCache();
  const created = createPluginMark(mark(1), SESSION);
  const snapshot = snapshotComposerDraft(`${created.token}`, [created], SESSION);
  assert.deepEqual(snapshot.fileReferences, [
    { path: "", name: "#1", kind: "file", token: created.token, plugin: created.plugin },
  ]);
  assert.deepEqual(draftFileReference(created), snapshot.fileReferences[0]);
  assert.equal(sameDraftFileReference(created, snapshot.fileReferences[0]), true);
  const resent = { ...created, plugin: { ...created.plugin, send: "other" } };
  assert.equal(sameDraftFileReference(created, resent), false, "a different send is another draft");
  const plain = { ...created, plugin: undefined };
  assert.equal(sameDraftFileReference(created, plain), false);
  const folded = { ...created, plugin: { kind: "fold", pluginId: "demo.lab", send: "a", count: 1 } };
  assert.equal(sameDraftFileReference(folded, { ...folded, plugin: { ...folded.plugin, count: 2 } }), false);
  const attachment = { kind: "attachment", pluginId: "demo.lab", id: "att-1", size: 3 };
  assert.equal(
    sameDraftFileReference({ ...plain, plugin: attachment }, { ...plain, plugin: { ...attachment } }),
    true,
  );
});
