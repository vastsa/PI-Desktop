import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as annotations from "../src/lib/response-annotations.ts";
import * as queued from "../src/lib/queued-prompts.ts";
import * as sideChats from "../src/lib/side-chat.ts";
import * as tabs from "../src/lib/work-panel-tabs.ts";
import * as resize from "../src/lib/work-panel-resize.ts";
import * as panes from "../src/lib/session-panes.ts";

// Execute the real domain factories with a fake host; no app, database, or model.
function load(path, imports) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}
const annotation = (id) => annotations.responseAnnotation({ id, messageId: `message-${id}`, text: `excerpt ${id}` });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function queueHarness({ running = true, materialize } = {}) {
  const ack = deferred();
  const calls = [];
  const notices = [];
  const state = {
    activeSessionId: "s1", pendingPlans: {}, runningSessions: { s1: running },
    responseAnnotations: { s1: [annotation("a1"), annotation("a2")], s2: [annotation("other")] },
    sessions: [{ id: "s1", title: "Title" }], messages: [], queuedPrompts: {},
    latestTurnResults: {}, sessionOutcomes: {}, sideChats: {}, sideChatTranscripts: {},
    showToast: (...args) => notices.push(args),
  };
  const access = {
    get: () => state,
    set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update),
  };
  const { createQueueSlice } = load("../src/stores/slices/queue-slice.ts", {
    i18next: { default: { t: (key) => key } },
    "../../lib/api": { api: {
      queuePrompt: (request) => { calls.push(request); return ack.promise; },
      prompt: (request) => { calls.push(request); return ack.promise; },
      listQueuedPrompts: async () => ({ entries: [] }),
    } },
    "../../lib/response-annotations": annotations,
    "../../lib/queued-prompts": queued,
    "../../lib/session-transcript": { optimisticUserMessage: (id, content) => ({ id, role: "user", content }) },
  });
  Object.assign(state, createQueueSlice({
    ...access,
    runtime: {
      sessionTranscriptCache: new Map(), submittedComposerDrafts: new Map(),
      beginNavigationIntent: () => 1,
      insertOptimisticUserMessage: (_, message) => state.messages.push(message),
      retractOptimisticUserMessage: (_, message) => { state.messages = state.messages.filter((item) => item !== message); },
    },
    materializeDraftSession: () => materialize(),
    promptAttachmentsFromDraft: () => [],
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    isDefaultSessionTitle: () => false,
    viewingSessionIdForPrompt: () => "s1",
    messageErrorFromUnknown: (error) => ({ code: "TEST", message: error.message }),
    assistantErrorMessage: (error) => ({ role: "assistant", error }),
  }));
  return { state, ack, calls, notices };
}

for (const running of [true, false]) {
  test(`${running ? "queue" : "send"} consumes only acknowledged unchanged annotations in the originating session`, async () => {
    const { state, ack, calls } = queueHarness({ running });
    const submitted = [...state.responseAnnotations.s1];
    const send = state.sendPrompt("request", { text: "request", fileReferences: [] });
    assert.equal(calls.length, 1);
    assert.equal(state.responseAnnotations.s1.length, 2, "must not consume before acknowledgement");
    assert.equal(calls[0].content, annotations.responseAnnotationPrompt("request", submitted));
    const edited = { ...submitted[1], annotation: "edited while waiting" };
    const added = annotation("new");
    state.responseAnnotations.s1 = [submitted[0], edited, added];
    state.activeSessionId = "s2";
    ack.resolve({ id: "queue-1" });
    assert.equal(await send, true);
    assert.deepEqual(state.responseAnnotations.s1, [edited, added]);
    assert.equal(state.responseAnnotations.s2[0].id, "other");
  });

  test(`${running ? "queue" : "send"} failure retains annotations and reports rejection`, async () => {
    const { state, ack, notices } = queueHarness({ running });
    const before = state.responseAnnotations.s1;
    const send = state.sendPrompt("", { text: "", fileReferences: [] });
    ack.reject(new Error("host refused"));
    assert.equal(await send, false);
    assert.equal(state.responseAnnotations.s1, before);
    if (running) {
      assert.equal(notices[0][0], "host refused");
      assert.equal(state.queuedPrompts.s1?.length ?? 0, 0);
    } else assert.equal(state.latestTurnResults.s1.status, "failed");
  });
}

test("ordinary queued text still waits for host acceptance without annotations", async () => {
  const { state, ack, calls } = queueHarness();
  state.responseAnnotations = {};
  const send = state.sendPrompt("plain", { text: "plain", fileReferences: [] });
  assert.equal(calls[0].content, "plain");
  ack.resolve({ id: "queue-1" });
  assert.equal(await send, true);
  assert.deepEqual(state.responseAnnotations, {});
});

for (const withOtherTab of [false, true]) {
  test(`closing side chat ${withOtherTab ? "beside another tab" : "as final tab"} preserves upstream launcher and durable child`, () => {
    const child = sideChats.sideChatWorkPanelTab("child");
    const other = tabs.toolWorkPanelTab("review");
    const state = {
      activeSessionId: "parent", workPanelOpen: true,
      workPanelTabs: withOtherTab ? [child, other] : [child], activeWorkPanelTabId: child.id,
      workPanelFileRequest: null, workPanelContexts: {},
      sideChats: { child: { sessionId: "child", parentSessionId: "parent" }, unrelated: { sessionId: "unrelated" } },
      sideChatTranscripts: { child: [], unrelated: [] }, sessions: [{ id: "child" }],
    };
    const { createWorkPanelSlice } = load("../src/stores/slices/work-panel-slice.ts", {
      "../../lib/api": { api: {} }, "../../lib/side-chat": sideChats,
      "../../lib/work-panel-tabs": tabs, "../../lib/work-panel-resize": resize,
    });
    const actions = createWorkPanelSlice({ get: () => state, set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update), isSessionSelectionPending: () => false });
    actions.closeWorkPanelTab(child.id);
    assert.equal(state.workPanelOpen, true);
    assert.equal(state.activeWorkPanelTabId, withOtherTab ? other.id : null);
    assert.equal(state.sideChats.child, undefined);
    assert.equal(state.sideChatTranscripts.child, undefined);
    assert.ok(state.sideChats.unrelated);
    assert.ok(state.sideChatTranscripts.unrelated);
    assert.deepEqual(state.sessions, [{ id: "child" }]);
    assert.deepEqual(state.workPanelContexts.parent.tabs, withOtherTab ? [other] : []);
  });
}

test("failed submission draft restoration never overwrites newer input or another session", () => {
  const source = readFileSync(new URL("../src/features/chat/composer/hooks/useComposerDraft.ts", import.meta.url), "utf8");
  const body = source.match(/const restoreDraftForKey = \(key: string, snapshot: ComposerDraftSnapshot\) => \{[\s\S]*?\n  \};/)[0];
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [active, newer] of [["s1", "new input"], ["s2", "cached input"], ["s2", ""]]) {
    const writes = [], values = [];
    const snapshot = { text: "failed draft", fileReferences: [] };
    runInNewContext(code + '; restoreDraftForKey("s1", snapshot);', {
      snapshot, useAppStore: { getState: () => ({ activeSessionId: active }) },
      draftKeyForSession: (id) => id, readComposerDraft: () => ({ text: newer }),
      writeComposerDraft: (...args) => writes.push(args), valueRef: { current: newer },
      setValue: (value) => values.push(value), setFileReferences() {}, setCursor() {},
    });
    assert.deepEqual(values, []);
    assert.equal(writes.length, active === "s2" && !newer ? 1 : 0);
  }
});

test("user row edit seed and queue preview hide only the generated annotation block", () => {
  const row = readFileSync(new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url), "utf8");
  const status = readFileSync(new URL("../src/features/chat/composer/ComposerStatus.tsx", import.meta.url), "utf8");
  const editSeed = row.match(/const editSeed = ([^;]+);/)[1];
  const label = status.match(/const label =([\s\S]*?);/)[1];
  for (const request of ["plain text", "", "Explain this:\n## My request: extra"]) {
    for (const content of [request, annotations.responseAnnotationPrompt(request, [annotation("a1")])]) {
      const context = { requestTextWithoutAnnotations: annotations.requestTextWithoutAnnotations, message: { content }, editableUserMessage: true };
      assert.equal(runInNewContext(editSeed, context), request);
      assert.equal(runInNewContext(label, { ...context, item: { content, draft: { fileReferences: [] } }, t: () => "empty" }), request || "empty");
    }
  }
});

test("side-chat and background projections share upstream delta accumulation, including while the child is active", async () => {
  const shared = await import("@pi-desktop/shared");
  const transcript = await import("../src/lib/session-transcript.ts");
  const { createSessionRuntime } = load("../src/stores/runtime/session-runtime.ts", {
    "@pi-desktop/shared": shared,
    "../../lib/api": { api: {} },
    "../../lib/navigation-intent": { createNavigationIntentController: () => ({}) },
    "../../lib/session-transcript": transcript,
    "../../lib/sidebar-preferences": {},
    "../../lib/sidebar-session-groups": {},
    "../../lib/tool-display": { formatToolValue: JSON.stringify },
    "../../lib/session-panes": panes,
  });
  const state = {
    activeSessionId: "child", messages: [], retainedTranscripts: {}, sessionHistory: {},
    sideChats: { child: {} }, sideChatTranscripts: { child: [] },
  };
  const runtime = createSessionRuntime({ get: () => state, set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update) });
  runtime.cacheSessionTranscript("child", []);
  const envelope = (event) => ({ sessionId: "child", event, ts: 1000 });
  const message = { id: "m1", role: "assistant", content: "", status: "streaming" };
  for (const event of [
    { type: "message_start", message },
    { type: "message_update", stream: "delta", deltaText: "first ", message },
    { type: "message_update", stream: "delta", deltaText: "second", message },
  ]) {
    runtime.projectSideChatEvent(envelope(event));
    runtime.cacheBackgroundTranscriptEvent(envelope(event));
  }
  assert.equal(state.sideChatTranscripts.child[0].content, "first second");
  assert.deepEqual(runtime.sessionTranscriptCache.get("child"), state.sideChatTranscripts.child);
  const optimistic = { id: "prompt", role: "user", content: "follow up" };
  runtime.insertOptimisticUserMessage("child", optimistic);
  assert.ok(state.sideChatTranscripts.child.includes(optimistic));
  runtime.retractOptimisticUserMessage("child", optimistic);
  assert.ok(!state.sideChatTranscripts.child.includes(optimistic));
  delete state.sideChats.child;
  const before = state.sideChatTranscripts.child;
  runtime.projectSideChatEvent(envelope({ type: "message_update", stream: "delta", deltaText: "ignored", message }));
  assert.equal(state.sideChatTranscripts.child, before);
});

test("delayed acknowledgement blocks repeat Enter for one session but not another, then releases", async () => {
  const { state, ack, calls } = queueHarness();
  const first = state.sendPrompt("", { text: "", fileReferences: [] });
  assert.equal(await state.sendPrompt("", { text: "", fileReferences: [] }), false);
  assert.equal(calls.length, 1);
  assert.equal(state.responseAnnotations.s1.length, 2);
  state.runningSessions.s2 = true;
  const other = state.sendPrompt("other", { text: "other", fileReferences: [] }, "s2");
  assert.equal(calls.length, 2);
  ack.resolve({ id: "queue-1" });
  assert.equal(await first, true);
  assert.equal(await other, true);
  assert.equal(await state.sendPrompt("next", { text: "next", fileReferences: [] }), true);
  assert.equal(calls.length, 3);
});

test("queue rejection releases the submission guard so a deliberate later attempt can run", async () => {
  const { state, ack, calls } = queueHarness();
  const first = state.sendPrompt("request");
  ack.reject(new Error("rejected"));
  assert.equal(await first, false);
  assert.equal(await state.sendPrompt("retry"), false);
  assert.equal(calls.length, 2, "second rejection came from a real attempt, not a stuck guard");
});

test("unexpected pre-host failure returns false and releases the submission guard", async () => {
  const { state, ack, calls } = queueHarness();
  const original = state.enqueuePrompt;
  state.enqueuePrompt = async () => { throw new Error("unexpected failure"); };
  assert.equal(await state.sendPrompt("request"), false);
  state.enqueuePrompt = original;
  ack.resolve({ id: "queue-1" });
  assert.equal(await state.sendPrompt("retry"), true);
  assert.equal(calls.length, 1);
});

test("draft submissions are fenced during materialization and after adopting their new session", async () => {
  const creation = deferred();
  let creates = 0;
  const { state, ack, calls } = queueHarness({ materialize: () => { creates++; return creation.promise; } });
  state.activeSessionId = undefined;
  const first = state.sendPrompt("draft");
  assert.equal(await state.sendPrompt("repeat draft"), false);
  assert.equal(creates, 1);
  state.activeSessionId = "s1";
  creation.resolve("s1");
  await Promise.resolve();
  assert.equal(await state.sendPrompt("repeat created"), false);
  assert.equal(calls.length, 1);
  ack.resolve({ id: "queue-1" });
  assert.equal(await first, true);
  assert.equal(await state.sendPrompt("next"), true);
  assert.equal(calls.length, 2);
});

test("upstream input routes Alt+Enter to steering, Shift+Enter to newline, and ignores IME confirmation", () => {
  const jsx = (type, props) => ({ type, props });
  const { ComposerInput } = load("../src/features/chat/composer/ComposerInput.tsx", {
    react: {}, "react/jsx-runtime": { jsx, jsxs: jsx },
    "./editor": {},
  });
  const submits = [];
  const tree = ComposerInput({ value: "text", runActive: true, enterToSend: true,
    composerAc: { close() {}, open: false, hasItems: false }, onSubmit: (steer) => submits.push(steer) });
  const input = tree.props.children.props.children[0];
  const key = (overrides) => input.props.onKeyDown({ key: "Enter", nativeEvent: {}, preventDefault() {}, ...overrides });
  key({ altKey: true });
  key({ shiftKey: true });
  key({ nativeEvent: { isComposing: true }, altKey: true });
  key({ nativeEvent: { keyCode: 229 }, altKey: true });
  key({});
  assert.deepEqual(submits, [true, undefined]);
});
