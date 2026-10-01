import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptReadingRuntime } = await import(
  "../src/stores/runtime/transcript-reading-runtime.ts"
);
const { transcriptViewMessages, transcriptViewFromSession } = await import("../src/lib/transcript-reading.ts");
const { getSessionMessageSnapshot } = await import("../src/lib/session-transcript-updates.ts");
const { mergeLiveSessionMessages, upsertLiveSessionMessage, projectMessageEnd, removeLiveSessionMessage } = await import("../src/lib/session-transcript.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { prepareTranscriptAction } = await import("../src/stores/runtime/transcript-action.ts");

const target = (messageId) => ({ sessionId: "s", messageId, query: "needle" });
const message = (id, content = id, extra = {}) => ({
  id,
  role: "user",
  content,
  createdAt: `2026-09-13T00:00:00Z`,
  ...extra,
});
const page = (messages, options = {}) => ({
  session: {
    id: "s",
    messages,
    messageStart: 20,
    messageEnd: 80,
    hasMoreBefore: true,
    hasMoreAfter: true,
    ...options,
  },
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function reader(read, overrides = {}) {
  const errors = [];
  let runtime;
  let state = {
    activeSessionId: "s",
    messages: [message("tail")],
    sessionHistory: { s: { messageStart: 120, hasMoreBefore: true } },
    transcriptViews: {},
    retainedSessionIds: ["s"],
    retainedTranscripts: {},
    runningSessions: {},
    showToast: (error) => errors.push(error),
    ...overrides,
  };
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      runtime?.reconcile(state, previous);
    },
  };
  runtime = createTranscriptReadingRuntime(access, read);
  return {
    ...access,
    ...runtime.actions,
    errors,
    view: () => state.transcriptViews.s,
    visible: () => transcriptViewMessages(state.messages, state.transcriptViews.s),
  };
}

test("a search jump keeps complete focused text without changing live/model input", async () => {
  const calls = [];
  const content = `${"prefix ".repeat(15_000)}needle`;
  const r = reader(async (...args) => {
    calls.push(args);
    return page([message("old", content)]);
  });
  const live = r.get().messages;
  await r.navigateTranscript(target("old"));
  assert.deepEqual(calls, [["s", { messageAround: "old", messageLimit: 60, contentLimit: 65536 }]]);
  assert.equal(r.visible()[0].content, content);
  assert.equal(r.view().focus.messageId, "old");
  assert.equal(r.view().loading, null);
  assert.equal(r.get().messages, live);
});

test("the latest click owns completion and obsolete errors", async () => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  const r = reader(() => (++count === 1 ? first : second).promise);
  const a = r.navigateTranscript(target("a"));
  const b = r.navigateTranscript(target("b"));
  second.resolve(page([message("b")]));
  await b;
  first.reject(new Error("obsolete request"));
  await a;
  assert.equal(r.view().focus.messageId, "b");
  assert.deepEqual(r.errors, []);
});

test("both directions use physical cursors, deduplicate overlap, and preserve focused text", async () => {
  const calls = [];
  const responses = [
    page([message("a"), message("b", "full needle"), message("c")]),
    page([message("b", "clipped"), message("c"), message("d")], {
      messageStart: 70,
      messageEnd: 130,
      hasMoreAfter: false,
    }),
    page([message("z"), message("a")], { messageStart: 0, messageEnd: 20, hasMoreBefore: false }),
  ];
  const r = reader(async (_id, options) => {
    calls.push(options);
    return responses.shift();
  });
  await r.navigateTranscript(target("b"));
  await r.loadTranscriptPage("s", "after");
  assert.equal(calls[1].messageBefore, 140);
  await r.loadTranscriptPage("s", "before");
  assert.equal(calls[2].messageBefore, 20);
  assert.deepEqual(
    r.visible().map((item) => item.id),
    ["z", "a", "b", "c", "d"],
  );
  assert.equal(r.visible()[2].content, "full needle");
  assert.equal(r.view().hasMoreBefore, false);
  assert.equal(r.view().hasMoreAfter, false);
  await r.loadTranscriptPage("s", "after");
  assert.equal(calls.length, 3);
});

test("ordinary history uses the same page ownership and keeps receiving live output", async () => {
  const calls = [];
  const first = deferred();
  const r = reader(async (_id, options) => {
    calls.push(options);
    return calls.length === 1
      ? first.promise
      : page([message("oldest")], {
          messageStart: 0,
          messageEnd: 20,
          hasMoreBefore: false,
          hasMoreAfter: true,
        });
  });
  const live = r.get().messages;
  const loading = r.loadTranscriptPage("s", "before");
  await r.loadTranscriptPage("s", "before");
  assert.equal(calls.length, 1, "coalesce repeated top-boundary events");
  first.resolve(page([message("older")], { messageStart: 20, messageEnd: 120 }));
  await loading;
  assert.equal(r.get().messages, live, "reading does not hydrate model input");
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["older", "tail"],
  );
  r.set({
    runningSessions: { s: true },
    messages: [...live, message("stream", "partial", { status: "streaming" })],
  });
  await r.loadTranscriptPage("s", "before");
  assert.equal(
    calls[1].messageBefore,
    20,
    "continue the reading cursor, not the live cache cursor",
  );
  assert.equal(calls[1].messageLimit, 100);
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["oldest", "older", "tail", "stream"],
  );
  assert.equal(r.visible().at(-1).content, "partial");
});

test("search supersedes an ordinary page and return-to-latest cancels historical paging", async () => {
  const older = deferred();
  const later = deferred();
  let count = 0;
  const r = reader(() => {
    count += 1;
    return count === 1
      ? older.promise
      : count === 2
        ? Promise.resolve(page([message("hit")]))
        : later.promise;
  });
  const normal = r.loadTranscriptPage("s", "before");
  await r.navigateTranscript(target("hit"));
  older.resolve(page([message("obsolete")]));
  await normal;
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["hit"],
  );
  const load = r.loadTranscriptPage("s", "after");
  r.returnToLatestTranscript("s");
  later.resolve(page([message("obsolete-later")]));
  await load;
  assert.equal(r.view(), undefined);
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["tail"],
  );
});

test("a nested result opens its real Task and exposes its answer even outside the page", async () => {
  const child = message("child", "needle", {
    role: "assistant",
    parentToolCallId: "task-call",
    agentName: "reviewer",
  });
  const parent = message("parent-row", "", {
    role: "tool",
    toolName: "Task",
    toolCallId: "task-call",
  });
  const r = reader(async () => page([child], { navigationParent: parent }));
  await r.navigateTranscript(target("child"));
  assert.equal(r.view().focus.messageId, "child");
  const { entries } = buildTranscriptEntries(r.visible());
  const task = entries[0].parts[0].items[0];
  assert.equal(task.message.id, parent.id);
  assert.equal(task.delegate.items[0].message.id, child.id);
  assert.equal(r.view().messageStart, 20, "parent context does not move physical cursors");
  r.returnToLatestTranscript("s");
});

test("a failed search cannot restore a cancelled page's loading state or ownership", async () => {
  const older = deferred();
  const search = deferred();
  let calls = 0;
  const r = reader(() => (++calls === 1 ? older.promise : search.promise));
  const loading = r.loadTranscriptPage("s", "before");
  const navigation = r.navigateTranscript(target("missing"));
  older.resolve(page([message("discarded")]));
  await loading;
  search.resolve({ session: null });
  await navigation;
  assert.equal(r.view().loading, null);
  assert.equal(r.view().focus, null);
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["tail"],
  );
});

test("deleted targets and missing parent tasks report failure and preserve the previous view", async () => {
  for (const response of [
    page([message("different")]),
    page([message("deleted", "needle", { parentToolCallId: "missing" })]),
  ]) {
    const r = reader(async () => response);
    await r.navigateTranscript(target("deleted"));
    assert.deepEqual(
      r.visible().map((m) => m.id),
      ["tail"],
    );
    assert.equal(r.view().focus, null);
    assert.match(r.errors[0], /no longer exists/);
  }
});

test("new turns, pane eviction, and canonical edits invalidate pending reads", async () => {
  for (const change of [
    { runningSessions: { s: true } },
    { retainedSessionIds: [] },
    { messages: [message("tail", "edited with the same id")] },
    { messages: [] },
  ]) {
    const pending = deferred();
    const r = reader(() => pending.promise);
    const navigation = r.navigateTranscript(target("old"));
    r.set(change);
    pending.resolve(page([message("old")]));
    await navigation;
    assert.equal(r.view(), undefined);
    assert.deepEqual(r.errors, []);
  }
});

test("a session switch cannot let an old nested search open the new session's panel", async () => {
  const pending = deferred();
  const r = reader(() => pending.promise);
  const navigation = r.navigateTranscript(target("child"));
  r.set({ activeSessionId: "other", retainedSessionIds: ["other", "s"] });
  pending.resolve(
    page([message("child", "needle", { parentToolCallId: "task" })], {
      navigationParent: message("task", "", { role: "tool", toolName: "Task", toolCallId: "task" }),
    }),
  );
  await navigation;
  assert.equal(r.view(), undefined);
});

test("an explicit old-message action loads canonical input only when required", async () => {
  let state = {
    activeSessionId: "s",
    messages: [message("tail")],
    sessionHistory: { s: { hasMoreBefore: false } },
  };
  const access = {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
  };
  const full = [message("old"), message("tail")];
  let reads = 0;
  let cached;
  const runtime = {
    loadFullSessionMessages: async (_id, cache) => {
      assert.equal(cache, false);
      reads += 1;
      return full;
    },
    cacheSessionTranscript: (_id, messages) => {
      cached = messages;
    },
  };
  assert.equal(await prepareTranscriptAction(access, runtime, "tail"), state);
  assert.equal(reads, 0);
  await prepareTranscriptAction(access, runtime, "old");
  assert.equal(reads, 1);
  assert.equal(state.messages, full);
  assert.equal(cached, full);
  assert.deepEqual(state.sessionHistory.s, { messageStart: 0, hasMoreBefore: false });
});

test("action preparation cannot overwrite a later navigation or newly started turn", async () => {
  for (const change of [
    { activeSessionId: "other" },
    { isRunning: true },
    { messages: [message("tail", "edited")] },
  ]) {
    let state = { activeSessionId: "s", messages: [message("tail")], sessionHistory: {} };
    const pending = deferred();
    const read = prepareTranscriptAction(
      { get: () => state, set: () => assert.fail("stale action must not write") },
      {
        loadFullSessionMessages: () => pending.promise,
        cacheSessionTranscript: () => assert.fail("stale action must not replace the live cache"),
      },
      "old",
    );
    state = { ...state, ...change };
    pending.resolve([message("old")]);
    assert.equal(await read, null);
  }
});

test("a visible message still hydrates canonical input when the tail is bounded or clipped", async () => {
  for (const history of [{ hasMoreBefore: true }, { hasMoreBefore: false, contentLimited: true }]) {
    let state = {
      activeSessionId: "s",
      messages: [message("visible", "clipped")],
      sessionHistory: { s: history },
    };
    const full = [message("earlier"), message("visible", "complete original content")];
    const access = {
      get: () => state,
      set: (patch) => {
        state = { ...state, ...patch };
      },
    };
    await prepareTranscriptAction(
      access,
      {
        loadFullSessionMessages: async () => full,
        cacheSessionTranscript: (_id, messages) => assert.equal(messages, full),
      },
      "visible",
    );
    assert.equal(state.messages, full);
    assert.equal(state.sessionHistory.s.hasMoreBefore, false);
    assert.notEqual(state.sessionHistory.s.contentLimited, true);
  }
});

test("paging during an existing stream never freezes its snapshot over newer tokens or completion", async () => {
  const delayed = deferred();
  const initial = message("reply", "first token", { role: "assistant", status: "streaming" });
  const r = reader(() => delayed.promise, { messages: [initial], runningSessions: { s: true } });
  const loading = r.loadTranscriptPage("s", "before");
  const streaming = { ...initial, content: "more tokens" };
  r.set({ messages: [streaming] });
  assert.equal(r.visible().at(-1), streaming);
  delayed.resolve(page([message("older"), initial], { messageStart: 0, hasMoreBefore: false }));
  await loading;
  assert.equal(r.visible().at(-1), streaming);
  const complete = { ...streaming, content: "complete answer", status: "complete" };
  r.set({ messages: [complete], runningSessions: {} });
  assert.deepEqual(
    r.visible().map((item) => item.id),
    ["older", "reply"],
  );
  assert.equal(r.visible().at(-1), complete);
});

function fullReadingProjection(live, view) {
  const current = new Map(live.map((row) => [row.id, row]));
  return mergeLiveSessionMessages(view.messages, live).map((row) => current.get(row.id) ?? row);
}

test("ordinary reading replaces only changed overlap without rereading historical ids", () => {
  let reads = 0;
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    ...message(`old-${index}`),
    get id() { reads++; return `old-${index}`; },
  }));
  const live = [...rows, message("tail", "partial", { role: "assistant", status: "streaming" })];
  const view = transcriptViewFromSession(page([message("earlier"), ...live]).session);
  const first = transcriptViewMessages(live, view);
  assert.equal(transcriptViewMessages(live, view), first);
  reads = 0;
  const nextLive = upsertLiveSessionMessage(live, message("tail", "final", { role: "assistant", status: "complete" }));
  const next = transcriptViewMessages(nextLive, view);
  assert.equal(reads, 0);
  assert.equal(next.at(-1), nextLive.at(-1));
  assert.equal(first.at(-1).content, "partial");
  const before = getSessionMessageSnapshot(first);
  const after = getSessionMessageSnapshot(next);
  assert.equal(before.owner, after.owner);
  assert.equal(before.positions, after.positions);
  assert.equal(before.blocks[0], after.blocks[0]);
  assert.notEqual(before.blocks.at(-1), after.blocks.at(-1));
});

test("reading overlap includes skipped non-tail updates and remains safe for older renders", () => {
  const live = Array.from({ length: 200 }, (_, index) => message(`row-${index}`));
  const view = transcriptViewFromSession(page([message("older"), ...live.slice(0, 5)]).session);
  const first = transcriptViewMessages(live, view);
  const early = upsertLiveSessionMessage(live, message("row-2", "changed early"));
  const late = upsertLiveSessionMessage(early, message("row-150", "changed late"));
  const latest = transcriptViewMessages(late, view);
  assert.deepEqual(latest, fullReadingProjection(late, view));
  assert.equal(latest[3].content, "changed early");
  assert.equal(latest[151].content, "changed late");
  assert.equal(first[3].content, "row-2");
  assert.deepEqual(transcriptViewMessages(early, view), fullReadingProjection(early, view));
  assert.deepEqual(transcriptViewMessages(late, view), latest);
});

test("reading cache invalidates structural changes, unrelated sources and changed view owners", () => {
  const view = transcriptViewFromSession(page([message("older")]).session);
  const initial = [message("a"), message("provisional", "partial", { role: "assistant" })];
  const first = transcriptViewMessages(initial, view);
  const appended = upsertLiveSessionMessage(initial, message("b"));
  assert.deepEqual(transcriptViewMessages(appended, view), fullReadingProjection(appended, view));
  const rekeyed = projectMessageEnd(appended, {
    type: "message_end", replacesMessageId: "provisional",
    message: message("durable", "final", { role: "assistant", status: "complete" }),
  });
  assert.deepEqual(transcriptViewMessages(rekeyed, view), fullReadingProjection(rekeyed, view));
  const removed = removeLiveSessionMessage(rekeyed, "a");
  assert.deepEqual(transcriptViewMessages(removed, view), fullReadingProjection(removed, view));
  const unknown = [message("replacement"), message("replacement", "last duplicate")];
  assert.deepEqual(transcriptViewMessages(unknown, view), fullReadingProjection(unknown, view));
  const changedView = { ...view, messages: [message("different history")] };
  assert.deepEqual(transcriptViewMessages(removed, changedView), fullReadingProjection(removed, changedView));
  assert.deepEqual(first.map((row) => row.id), ["older", "a", "provisional"]);
  assert.equal(transcriptViewMessages(removed), removed, "return to latest bypasses the reading cache");
});

test("timestamp corrections remerge chronological positions instead of patching stale order", () => {
  const at = (id, day) => message(id, id, { createdAt: `2026-09-${day}T00:00:00Z` });
  const keep = at("keep", 20);
  const live = [keep, at("old", 10), at("tail", 30)];
  const view = transcriptViewFromSession(page([keep]).session);
  assert.deepEqual(transcriptViewMessages(live, view).map((row) => row.id), ["old", "keep", "tail"]);
  const corrected = upsertLiveSessionMessage(live, at("old", 25));
  assert.deepEqual(transcriptViewMessages(corrected, view), fullReadingProjection(corrected, view));
  assert.deepEqual(transcriptViewMessages(corrected, view).map((row) => row.id), ["keep", "old", "tail"]);
});

test("focused search never reads unused live identities, including parent context", () => {
  const live = [{ ...message("unused"), get id() { assert.fail("historical search indexed live rows"); } }];
  const parent = message("task", "latest parent", { role: "tool" });
  const view = transcriptViewFromSession(page([message("hit")], { navigationParent: parent }).session, target("hit"));
  assert.deepEqual(transcriptViewMessages(live, view), [parent, view.messages[0]]);
  const overlapping = { ...view, messages: [message("task", "old parent"), ...view.messages] };
  assert.deepEqual(transcriptViewMessages(live, overlapping), [parent, view.messages[0]]);
});

test("ordinary parent context stays authoritative over tracked live changes", () => {
  const parent = message("task", "navigation parent", { role: "tool" });
  const view = transcriptViewFromSession(page([message("hit")], { navigationParent: parent }).session);
  const live = [message("task", "live parent", { role: "tool" }), message("tail")];
  const initial = transcriptViewMessages(live, view);
  const updated = upsertLiveSessionMessage(live, message("task", "new live parent", { role: "tool" }));
  const next = transcriptViewMessages(updated, view);
  assert.equal(next, initial);
  assert.equal(next.find((row) => row.id === "task"), parent);
});
