import { readStoreSource, readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { responseAnnotationPrompt, requestTextWithoutAnnotations } from "../src/lib/response-annotations.ts";

const source = await readComposerSource();
const ast = ts.createSourceFile("Composer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, `${name} must exist in the real composer`);
  return result;
}
const submitCode = ts.transpileModule(`const submit = ${initializer("submit")};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + "submit();";
const annotation = { id: "a1", messageId: "m1", text: "selected text", annotation: "explain this", createdAt: 1 };

function harness({ text = "", annotations = [annotation], sendBlocked = false, modelReady = true, accepted = true } = {}) {
  const state = { activeSessionId: "s1", responseAnnotations: { s1: annotations } };
  const sent = [];
  const restored = [];
  const context = {
    value: text, draft: {
      ref: { current: null },
      draftSnapshot: (value) => ({ text: value.trim(), fileReferences: [] }),
      clearDraftForKey() {},
      restoreDraftForKey: (key, value) => restored.push([key, value]),
    }, activeSessionId: "s1", activeFileReferences: [],
    useAppStore: { getState: () => state }, hasAnnotations: annotations.length > 0,
    serializeInlineComposerFileReferences: (value) => value.trim(),
    serializeComposerFileReferences: (value) => value.trim(),
    sendBlocked, pasting: false, modelReady, draftKey: "s1",
    invalidatePromptEnhancement() {}, clearDraftForKey() {},
    showToast() {}, t: (key) => key,
    draftSnapshot: (value) => ({ text: value.trim(), fileReferences: [] }),
    restoreDraftForKey: (key, draft) => restored.push([key, draft]),
    sendPrompt: async (content, draft) => {
      sent.push({ content, draft, wire: responseAnnotationPrompt(content, state.responseAnnotations.s1) });
      if (accepted) state.responseAnnotations.s1 = [];
      return accepted;
    },
  };
  context.steerPrompt = async (content, draft) => { sent.push({ content, draft, steering: true }); return accepted; };
  return { state, sent, restored, context, submit: (steering = false) => runInNewContext(`(async () => { ${submitCode.replace("submit();", `return submit(${steering});`)} })()`, context) };
}

test("saved annotations enable Send even when the composer text is empty", () => {
  for (const value of ["", "  \n"]) {
    assert.equal(runInNewContext(initializer("hasDraftContent"), { value, hasAnnotations: true }), true);
    assert.equal(runInNewContext(initializer("hasDraftContent"), { value, hasAnnotations: false }), false);
  }
  assert.match(source, /runActive && !hasDraftContent/);
  assert.match(source, /disabled=\{\s*!hasDraftContent \|\|\s*sendBlocked/);
});

test("the real submit handler sends only saved annotations without inventing request text", async () => {
  const view = harness();
  await view.submit();
  assert.equal(view.sent.length, 1);
  assert.equal(view.sent[0].content, "");
  assert.equal(view.sent[0].draft.text, "");
  assert.ok(view.sent[0].wire.includes('"annotation":"explain this"'));
  assert.equal(requestTextWithoutAnnotations(view.sent[0].wire), "");
  assert.equal(view.state.responseAnnotations.s1.length, 0);
  // A second click before React updates must not send an empty prompt.
  await view.submit();
  assert.equal(view.sent.length, 1);
});

test("empty, blocked, unconfigured and other-session annotations do not bypass send gates", async () => {
  for (const options of [{ annotations: [] }, { sendBlocked: true }, { modelReady: false }]) {
    const view = harness(options);
    await view.submit();
    assert.equal(view.sent.length, 0);
  }
  const other = harness();
  other.state.responseAnnotations = { s2: [annotation] };
  await other.submit();
  assert.equal(other.sent.length, 0);
});

test("a rejected annotation-only submit retains the annotations", async () => {
  const view = harness({ accepted: false });
  await view.submit();
  assert.equal(view.sent.length, 1);
  assert.equal(view.state.responseAnnotations.s1.length, 1);
  assert.equal(view.restored.length, 1);
});

test("the real store queues an annotation-only prompt while the session is running", async () => {
  const store = await readStoreSource();
  const storeAst = ts.createSourceFile("app-store.ts", store, ts.ScriptTarget.Latest, true);
  let handler;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(storeAst) === "sendPrompt") handler = node.initializer.getText(storeAst);
    ts.forEachChild(node, visit);
  }
  visit(storeAst);
  assert.ok(handler);
  const queued = [];
  const state = { activeSessionId: "s1", pendingPlans: {}, runningSessions: { s1: true }, sessions: [], sideChats: {},
    responseAnnotations: { s1: [annotation], s2: [annotation] },
    enqueuePrompt: async (...args) => { queued.push(args); return true; },
  };
  const code = ts.transpileModule(`const send = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const accepted = await runInNewContext(code + 'send("", { text: "", fileReferences: [] });', {
    pendingSubmissions: new Set(), get: () => state, set: (update) => Object.assign(state, update(state)), responseAnnotationPrompt,
  });
  assert.equal(accepted, true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][2], "s1");
  assert.equal(queued[0][0], responseAnnotationPrompt("", [annotation]));
  assert.equal(state.responseAnnotations.s1, undefined);
  assert.equal(state.responseAnnotations.s2.length, 1);
});

test("a host-trimmed annotation-only prompt never exposes the wire block in the transcript", () => {
  const wire = responseAnnotationPrompt("", [annotation]);
  assert.equal(requestTextWithoutAnnotations(wire.trim()), "");
  const request = "Explain this heading:\n## My request: extra";
  assert.equal(requestTextWithoutAnnotations(responseAnnotationPrompt(request, [annotation])), request);
});


test("steering is text-only and preserves saved annotations; annotation-only steering does nothing", async () => {
  const empty = harness();
  await empty.submit(true);
  assert.equal(empty.sent.length, 0);
  assert.equal(empty.state.responseAnnotations.s1.length, 1);
  const text = harness({ text: "steer the active turn" });
  await text.submit(true);
  assert.equal(text.sent.length, 1);
  assert.equal(text.sent[0].steering, true);
  assert.equal(text.sent[0].content, "steer the active turn");
  assert.equal(text.state.responseAnnotations.s1.length, 1);
});
