import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The composer draft as plugins read and write it
 * (`docs/plugin-plan/render/draft/`, `docs/plugin-plan/render/attachments/`):
 * the per-plugin view, the replacement plan, and the bridge that owns the
 * generation, the gates and the attachments of the composer taking input.
 */
const { PLUGIN_ATTACHMENTS_MAX, PLUGIN_DRAFT_MAX_MARKS } = await import("@pi-desktop/plugin-sdk");
const { createFileReference, nextChipToken } = await import(
  "../src/features/chat/composer/editor.ts"
);
const { createPluginMark, foldLabel } = await import(
  "../src/features/chat/composer/plugins/plugin-marks.ts"
);
const { draftSignature, planDraftReplacement, pluginDraftView } = await import(
  "../src/features/chat/composer/plugins/plugin-draft.ts"
);
const { ComposerDraftBridge } = await import(
  "../src/features/chat/composer/plugins/draft-bridge.ts"
);
const { PluginRendererError } = await import("../src/plugins/renderer-error.ts");

const SELF = "demo.lab";
const OTHER = "demo.other";
const MARK = "\uFFFC";
const SID = "s1";

function hostChip(name, sessionId = SID) {
  return createFileReference(`/scratch/${name}`, name, sessionId, {
    kind: "file",
    token: nextChipToken(),
  });
}

function mark(pluginId, label, send = label) {
  return createPluginMark({ pluginId, label, send }, SID);
}

function fold(count) {
  return createFileReference("", foldLabel(count), SID, {
    kind: "file",
    token: nextChipToken(),
    plugin: { kind: "fold", pluginId: OTHER, send: "folded", count },
  });
}

function image(name) {
  return createFileReference(`/scratch/${name}`, name, SID, { kind: "image", mimeType: "image/png" });
}

function draftOf(text, references, sessionId = SID) {
  return { draftKey: sessionId ? `session:${sessionId}` : "home", sessionId, text, references };
}

function refused(code) {
  return (error) => {
    assert.ok(error instanceof PluginRendererError, `expected a PluginRendererError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("a plugin sees every chip as one mark char, in order, and only its own send text", () => {
  const file = hostChip("a.ts");
  const own = mark(SELF, "Issue 7", "issue #7 body");
  const theirs = mark(OTHER, "PR 3", "pr #3 body");
  const folded = fold(2);
  const elsewhere = hostChip("b.ts", "s2");
  const unused = hostChip("gone.ts");
  const draft = draftOf(
    `fix ${own.token} in ${file.token}, see ${theirs.token}${folded.token} ${MARK}`,
    [file, own, theirs, folded, elsewhere, unused, image("shot.png")],
  );
  const view = pluginDraftView(draft, SELF);
  assert.equal(view.text, `fix ${MARK} in ${MARK}, see ${MARK}${MARK} \uFFFD`);
  assert.deepEqual(view.marks, [
    { id: own.id, kind: "plugin", label: "Issue 7", pluginId: SELF, send: "issue #7 body" },
    { id: file.id, kind: "host", label: "a.ts" },
    { id: theirs.id, kind: "plugin", label: "PR 3", pluginId: OTHER },
    { id: folded.id, kind: "fold", label: foldLabel(2), count: 2 },
  ]);
  assert.equal(pluginDraftView(draft, OTHER).marks[2].send, "pr #3 body");
  assert.equal(pluginDraftView(draft, OTHER).marks[0].send, undefined);
});

test("the signature follows the draft, its key and its own references only", () => {
  const file = hostChip("a.ts");
  const base = draftOf(`x${file.token}`, [file]);
  const signature = draftSignature(base);
  assert.equal(draftSignature(null), "");
  assert.equal(draftSignature({ ...base, references: [...base.references, hostChip("b", "s2")] }), signature);
  assert.notEqual(draftSignature({ ...base, text: `y${file.token}` }), signature);
  assert.notEqual(draftSignature({ ...base, draftKey: "session:s9" }), signature);
  assert.notEqual(draftSignature({ ...base, references: [{ ...file, name: "renamed" }] }), signature);
  assert.notEqual(draftSignature({ ...base, references: [file, image("p.png")] }), signature);
  const folded = fold(1);
  const withFold = draftOf(`x${folded.token}`, [folded]);
  const joined = { ...folded, plugin: { ...folded.plugin, count: 2 } };
  assert.notEqual(draftSignature({ ...withFold, references: [joined] }), draftSignature(withFold));
});

test("a replacement moves chips by id, adds the caller's marks and keeps the rest", () => {
  const file = hostChip("a.ts");
  const own = mark(SELF, "Old");
  const theirs = mark(OTHER, "Theirs");
  const elsewhere = hostChip("b.ts", "s2");
  const shot = image("shot.png");
  const draft = draftOf(`${own.token} ${file.token} ${theirs.token}`, [elsewhere, file, own, theirs, shot]);

  const plan = planDraftReplacement(draft, SELF, `${MARK} first, then ${MARK}`, [
    { id: file.id },
    { label: "New", send: "new body" },
  ]);
  assert.ok(!("code" in plan), JSON.stringify(plan));
  const created = plan.references.at(-1);
  assert.equal(plan.text, `${file.token} first, then ${created.token}`);
  assert.deepEqual(created.plugin, { kind: "mark", pluginId: SELF, send: "new body" });
  assert.equal(created.name, "New");
  assert.equal(created.sessionId, SID);
  assert.deepEqual(
    plan.references.map((reference) => reference.id),
    [elsewhere.id, shot.id, file.id, created.id],
    "other sessions' references and detached images stay; dropped marks go",
  );
});

test("a replacement is refused for a dropped anchor, a bad id, a chip token or too many marks", () => {
  const file = hostChip("a.ts");
  const folded = fold(3);
  const own = mark(SELF, "Own");
  const draft = draftOf(`${file.token}${folded.token}${own.token}`, [file, folded, own]);
  const anchor = (text, marks) => planDraftReplacement(draft, SELF, text, marks).code;

  assert.equal(anchor(`${MARK}`, [{ id: folded.id }]), "PLUGIN_DRAFT_ANCHOR", "the host chip");
  assert.equal(anchor(`${MARK}`, [{ id: file.id }]), "PLUGIN_DRAFT_ANCHOR", "the fold");
  assert.equal(anchor(`${MARK}${MARK}`, [{ id: folded.id }, { id: file.id }]), undefined);
  assert.equal(
    anchor(`${MARK}${MARK}${MARK}`, [{ id: file.id }, { id: folded.id }, { id: "composer-file-0" }]),
    "PLUGIN_ACTION_INVALID_PAYLOAD",
  );
  assert.equal(
    anchor(`${MARK}${MARK}${MARK}`, [{ id: file.id }, { id: folded.id }, { id: file.id }]),
    "PLUGIN_ACTION_INVALID_PAYLOAD",
    "an id used twice",
  );
  assert.equal(
    anchor(`${MARK}${MARK}${file.token}`, [{ id: file.id }, { id: folded.id }]),
    "PLUGIN_ACTION_INVALID_PAYLOAD",
    "a chip token in the text",
  );
  const many = Array.from({ length: PLUGIN_DRAFT_MAX_MARKS }, (_, i) => ({ label: `m${i}`, send: `m${i}` }));
  assert.equal(
    anchor(MARK.repeat(PLUGIN_DRAFT_MAX_MARKS + 2), [{ id: file.id }, { id: folded.id }, ...many]),
    undefined,
    "the fold is no plugin mark",
  );
  assert.equal(
    anchor(MARK.repeat(PLUGIN_DRAFT_MAX_MARKS + 3), [
      { id: file.id },
      { id: folded.id },
      { id: own.id },
      ...many,
    ]),
    "PLUGIN_ACTION_INVALID_PAYLOAD",
  );
});

/** A composer handle over plain state, the way the composer lends its own. */
function fakeComposer({ text = "", references = [], sessionId = SID } = {}) {
  const state = {
    text,
    references,
    sessionId,
    blocked: false,
    focused: false,
    selection: null,
    writes: [],
    staged: [],
    stage: async (sid, file) => ({
      path: `/scratch/${sid}/${file.name}`,
      name: file.name,
      kind: file.mimeType.startsWith("image/") ? "image" : "file",
      mimeType: file.mimeType,
      size: file.data.byteLength,
    }),
  };
  const handle = {
    read: () =>
      state.blocked
        ? null
        : draftOf(state.text, state.references, state.sessionId),
    focused: () => state.focused,
    selection: () => state.selection ?? { start: state.text.length, end: state.text.length },
    write: (next, nextReferences, caret, focus) => state.writes.push({ next, nextReferences, caret, focus }),
    stage: (sid, file) => {
      state.staged.push([sid, file]);
      return state.stage(sid, file);
    },
  };
  /** Render the last write, as the composer does, and publish it. */
  const render = (bridge) => {
    const last = state.writes.at(-1);
    if (last) {
      state.text = last.next;
      state.references = last.nextReferences;
    }
    bridge.publish(handle);
  };
  return { state, handle, render };
}

function quietBridge() {
  const warnings = [];
  return { bridge: new ComposerDraftBridge((...args) => warnings.push(args)), warnings };
}

test("the generation moves with every change of the live draft, switches included", () => {
  const { bridge } = quietBridge();
  assert.throws(() => bridge.readDraft(SELF), refused("PLUGIN_ACTION_NO_COMPOSER"));
  const composer = fakeComposer({ text: "hello" });
  const unregister = bridge.register(composer.handle);
  const first = bridge.readDraft(SELF);
  assert.equal(first.text, "hello");
  bridge.publish(composer.handle);
  assert.equal(bridge.readDraft(SELF).generation, first.generation, "no change, same generation");

  composer.state.text = "hello!";
  assert.equal(bridge.readDraft(SELF).generation, first.generation + 1, "a read sees the change");
  composer.state.sessionId = "s2";
  bridge.publish(composer.handle);
  assert.equal(bridge.readDraft(SELF).generation, first.generation + 2, "another session's draft");

  // A composer mounted over it takes over until it goes.
  const over = fakeComposer({ text: "over" });
  const unregisterOver = bridge.register(over.handle);
  assert.equal(bridge.readDraft(SELF).text, "over");
  unregisterOver();
  unregisterOver();
  assert.equal(bridge.readDraft(SELF).text, "hello!");

  composer.state.blocked = true;
  assert.throws(() => bridge.readDraft(SELF), refused("PLUGIN_ACTION_NO_COMPOSER"));
  composer.state.blocked = false;
  unregister();
  assert.throws(() => bridge.insertText("x"), refused("PLUGIN_ACTION_NO_COMPOSER"));
});

test("insertText replaces the selection and focuses; the bridge reads its write until the render", () => {
  const { bridge } = quietBridge();
  const file = hostChip("a.ts");
  const composer = fakeComposer({ text: `ab${file.token}cd`, references: [file] });
  bridge.register(composer.handle);
  const before = bridge.readDraft(SELF).generation;
  composer.state.selection = { start: 1, end: 2 };

  const result = bridge.insertText("XY");
  assert.deepEqual(result, { ok: true, generation: before + 1 });
  assert.deepEqual(
    composer.state.writes.map(({ next, caret, focus }) => ({ next, caret, focus })),
    [{ next: `aXY${file.token}cd`, caret: 3, focus: true }],
  );
  assert.deepEqual(composer.state.writes[0].nextReferences, [file]);
  // Before the render the handle still holds the old text.
  assert.equal(bridge.readDraft(SELF).text, `aXY${MARK}cd`);
  bridge.insertText("Z");
  assert.equal(composer.state.writes[1].next, `aXYZ${file.token}cd`, "at the caret of the last write");

  composer.render(bridge);
  assert.equal(bridge.readDraft(SELF).generation, before + 2, "the render of the write is no change");
  assert.throws(() => bridge.insertText(`x${file.token}`), refused("PLUGIN_ACTION_INVALID_PAYLOAD"));
});

test("replaceDraft checks composer, gesture, focus, generation and anchors, in that order", () => {
  const { bridge } = quietBridge();
  assert.throws(
    () => bridge.replaceDraft(SELF, { expectedGeneration: 0, text: "", marks: [] }, false),
    refused("PLUGIN_ACTION_NO_COMPOSER"),
  );
  const file = hostChip("a.ts");
  const composer = fakeComposer({ text: `see ${file.token}`, references: [file] });
  bridge.register(composer.handle);
  const { generation } = bridge.readDraft(SELF);
  composer.state.focused = true;
  const dropping = { expectedGeneration: generation - 1, text: "all new", marks: [] };

  assert.throws(() => bridge.replaceDraft(SELF, dropping, false), refused("PLUGIN_DRAFT_REMOTE"));
  assert.throws(() => bridge.replaceDraft(SELF, dropping, true), refused("PLUGIN_DRAFT_FOCUSED"));
  composer.state.focused = false;
  assert.throws(() => bridge.replaceDraft(SELF, dropping, true), refused("PLUGIN_DRAFT_STALE"));
  const current = { ...dropping, expectedGeneration: generation };
  assert.throws(() => bridge.replaceDraft(SELF, current, true), refused("PLUGIN_DRAFT_ANCHOR"));
  assert.deepEqual(composer.state.writes, [], "a refusal writes nothing");

  const result = bridge.replaceDraft(
    SELF,
    { expectedGeneration: generation, text: `${MARK} and ${MARK}`, marks: [{ id: file.id }, { label: "N", send: "n" }] },
    true,
  );
  assert.equal(result.generation, generation + 1);
  const [write] = composer.state.writes;
  assert.equal(write.focus, false, "a replacement leaves focus alone");
  assert.equal(write.caret, write.next.length);
  assert.ok(write.next.startsWith(`${file.token} and `));
  assert.deepEqual(bridge.readDraft(SELF).marks.map((m) => m.kind), ["host", "plugin"]);
  assert.throws(
    () => bridge.replaceDraft(SELF, { ...current, text: `${MARK}`, marks: [{ id: file.id }] }, true),
    refused("PLUGIN_DRAFT_STALE"),
    "the old generation is spent",
  );
});

test("a subscriber gets the draft now and after each change, null when no composer takes input", () => {
  const { bridge, warnings } = quietBridge();
  const seen = [];
  const stop = bridge.subscribe(SELF, (snapshot) => seen.push(snapshot?.text ?? null));
  bridge.subscribe(OTHER, () => {
    throw new Error("listener bug");
  });
  assert.deepEqual(seen, [null]);
  const composer = fakeComposer({ text: "a" });
  const unregister = bridge.register(composer.handle);
  bridge.insertText("b");
  composer.render(bridge);
  bridge.publish(composer.handle);
  composer.state.blocked = true;
  bridge.publish(composer.handle);
  composer.state.blocked = false;
  bridge.publish(composer.handle);
  unregister();
  stop();
  stop();
  const again = fakeComposer({ text: "later" });
  bridge.register(again.handle);
  assert.deepEqual(seen, [null, "a", "ab", null, "ab", null]);
  assert.ok(warnings.length >= 5, "a throwing listener is logged and stays subscribed");
  assert.match(String(warnings[0][0]), /demo\.other draft listener failed/);
});

test("attachments are staged into the session's draft, listed and removed per plugin", async () => {
  const { bridge } = quietBridge();
  const composer = fakeComposer({ text: "hi" });
  bridge.register(composer.handle);
  const bytes = new Uint8Array([1, 2, 3]).buffer;

  const doc = await bridge.addAttachment(SELF, { name: "a.txt", mimeType: "text/plain", data: bytes });
  assert.equal(typeof doc.id, "string");
  assert.deepEqual(composer.state.staged, [[SID, { name: "a.txt", mimeType: "text/plain", data: bytes }]]);
  let write = composer.state.writes.at(-1);
  const docReference = write.nextReferences.at(-1);
  assert.equal(write.focus, false);
  assert.equal(write.next, `hi${docReference.token}`, "a file is a chip at the end");
  assert.deepEqual(docReference.plugin, { kind: "attachment", pluginId: SELF, id: doc.id, size: 3 });
  composer.render(bridge);

  const shot = await bridge.addAttachment(SELF, { name: "c.png", mimeType: "image/png", data: bytes });
  write = composer.state.writes.at(-1);
  assert.equal(write.next, `hi${docReference.token}`, "an image goes with the draft's images");
  assert.equal(write.nextReferences.at(-1).token, undefined);
  composer.render(bridge);
  const theirs = await bridge.addAttachment(OTHER, { name: "t.txt", mimeType: "text/plain", data: bytes });
  composer.render(bridge);

  assert.deepEqual(bridge.listAttachments(SELF), [
    { id: doc.id, name: "a.txt", mimeType: "text/plain", size: 3 },
    { id: shot.id, name: "c.png", mimeType: "image/png", size: 3 },
  ]);
  assert.equal(bridge.readDraft(SELF).marks.filter((m) => m.kind === "host").length, 2, "chips are host marks");
  assert.throws(() => bridge.removeAttachment(SELF, theirs.id), refused("PLUGIN_ATTACHMENT_NOT_FOUND"));
  assert.throws(() => bridge.removeAttachment(SELF, "nope"), refused("PLUGIN_ATTACHMENT_NOT_FOUND"));
  assert.deepEqual(bridge.removeAttachment(SELF, doc.id), { ok: true });
  write = composer.state.writes.at(-1);
  assert.equal(write.focus, false);
  assert.ok(!write.next.includes(docReference.token));
  composer.render(bridge);
  assert.deepEqual(bridge.listAttachments(SELF).map((a) => a.id), [shot.id]);

  // The user deleting the chip removes the attachment too.
  const theirReference = composer.state.references.find((r) => r.plugin?.id === theirs.id);
  composer.state.text = composer.state.text.replace(theirReference.token, "");
  bridge.publish(composer.handle);
  assert.deepEqual(bridge.listAttachments(OTHER), []);
});

test("attachments.add refuses home, a full plugin, a failed stage and a session switch", async () => {
  const { bridge } = quietBridge();
  const data = new Uint8Array([1]).buffer;
  const input = { name: "a.txt", mimeType: "text/plain", data };
  const composer = fakeComposer({ sessionId: "" });
  bridge.register(composer.handle);
  await assert.rejects(bridge.addAttachment(SELF, input), refused("PLUGIN_ATTACHMENT_NO_SESSION"));
  composer.state.sessionId = SID;

  composer.state.stage = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(bridge.addAttachment(SELF, input), (error) => {
    refused("PLUGIN_ATTACHMENT_FAILED")(error);
    assert.equal(error.message, "disk full");
    return true;
  });

  let release;
  composer.state.stage = (sid, file) =>
    new Promise((resolve) => {
      release = () => resolve({ path: `/x/${file.name}`, name: file.name, kind: "file", mimeType: "text/plain", size: 1 });
    });
  const switched = bridge.addAttachment(SELF, input);
  composer.state.sessionId = "s2";
  release();
  await assert.rejects(switched, refused("PLUGIN_ATTACHMENT_NO_SESSION"));
  assert.deepEqual(composer.state.writes, [], "nothing lands in the other session's draft");

  composer.state.sessionId = SID;
  composer.state.stage = async (_sid, file) => ({ path: `/x/${file.name}`, name: file.name, kind: "image", mimeType: "image/png", size: 1 });
  for (let i = 0; i < PLUGIN_ATTACHMENTS_MAX; i += 1) {
    await bridge.addAttachment(SELF, { ...input, name: `p${i}.png` });
    composer.render(bridge);
  }
  await assert.rejects(bridge.addAttachment(SELF, input), refused("PLUGIN_ATTACHMENT_LIMIT"));
  await bridge.addAttachment(OTHER, input);
});
