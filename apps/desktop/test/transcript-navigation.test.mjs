import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptNavigationController } from "../src/lib/transcript-navigation.ts";
import { prepareTranscriptAction } from "../src/stores/runtime/transcript-action.ts";

const target = (messageId, requestId = 1) => ({ sessionId: "s", messageId, requestId, query: "needle" });
const message = (id, content = id) => ({ id, role: "user", content });
const page = (messages, options = {}) => ({ session: {
  id: "s", messages, messageStart: 20, messageEnd: 80,
  hasMoreBefore: true, hasMoreAfter: true, ...options,
} });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("a search jump loads the stable target with a bounded original transcript read", async () => {
  const calls = [];
  const content = `${"prefix ".repeat(15_000)}needle`;
  const controller = new TranscriptNavigationController(async (...args) => {
    calls.push(args);
    return page([message("old", content)]);
  });
  await controller.navigate(target("old"));
  assert.deepEqual(calls, [["s", { messageAround: "old", messageLimit: 60, contentLimit: 65536 }]]);
  assert.equal(controller.getSnapshot().window.messages[0].content, content);
  assert.equal(controller.getSnapshot().target.messageId, "old");
  assert.equal(controller.getSnapshot().loading, false);
});

test("the most recently clicked message owns completion and errors", async () => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  const controller = new TranscriptNavigationController(() => (++count === 1 ? first : second).promise);
  const a = controller.navigate(target("a"));
  const b = controller.navigate(target("b", 2));
  second.resolve(page([message("b")]));
  await b;
  first.reject(new Error("obsolete request"));
  await a;
  assert.equal(controller.getSnapshot().target.messageId, "b");
  assert.equal(controller.getSnapshot().error, undefined);
});

test("both directions use physical cursors, deduplicate overlap, and keep focused text", async () => {
  const calls = [];
  const responses = [
    page([message("a"), message("b", "full needle"), message("c")]),
    page([message("b", "clipped"), message("c"), message("d")], { messageStart: 70, messageEnd: 130, hasMoreAfter: false }),
    page([message("z"), message("a")], { messageStart: 0, messageEnd: 20, hasMoreBefore: false }),
  ];
  const controller = new TranscriptNavigationController(async (_id, options) => {
    calls.push(options);
    return responses.shift();
  });
  await controller.navigate(target("b"));
  await controller.page("after");
  assert.equal(calls[1].messageBefore, 140, "use the physical end, not the number of returned messages");
  await controller.page("before");
  assert.equal(calls[2].messageBefore, 20);
  const window = controller.getSnapshot().window;
  assert.deepEqual(window.messages.map((item) => item.id), ["z", "a", "b", "c", "d"]);
  assert.equal(window.messages[2].content, "full needle");
  assert.equal(window.hasMoreBefore, false);
  assert.equal(window.hasMoreAfter, false);
  await controller.page("after");
  assert.equal(calls.length, 3);
});

test("returning to the live transcript cancels an outstanding historical page", async () => {
  const pending = deferred();
  let count = 0;
  const controller = new TranscriptNavigationController(() => ++count === 1
    ? Promise.resolve(page([message("a")])) : pending.promise);
  await controller.navigate(target("a"));
  const load = controller.page("after");
  controller.clear();
  pending.resolve(page([message("b")]));
  await load;
  assert.deepEqual(controller.getSnapshot(), { target: null, window: null, loading: false });
});

test("a deleted result cannot silently land at the newest message", async () => {
  const controller = new TranscriptNavigationController(async () => page([message("different")]));
  await controller.navigate(target("deleted"));
  assert.equal(controller.getSnapshot().window, null);
  assert.match(controller.getSnapshot().error, /no longer exists/);
});

test("an explicit action on an old message loads canonical input without changing sessions", async () => {
  let state = { activeSessionId: "s", messages: [message("tail")], sessionHistory: { s: { hasMoreBefore: true } } };
  const access = { get: () => state, set: (patch) => { state = { ...state, ...patch }; } };
  const full = [message("old"), message("tail")];
  let reads = 0;
  let cached;
  const runtime = {
    loadFullSessionMessages: async (_id, cache) => {
      assert.equal(cache, false, "defer cache writes until action ownership is rechecked");
      reads += 1; return full;
    },
    cacheSessionTranscript: (_id, messages) => { cached = messages; },
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
  for (const change of [{ activeSessionId: "other" }, { isRunning: true }]) {
    let state = { activeSessionId: "s", messages: [message("tail")], sessionHistory: {} };
    const pending = deferred();
    const access = { get: () => state, set: () => assert.fail("stale action must not write") };
    const read = prepareTranscriptAction(access, {
      loadFullSessionMessages: () => pending.promise,
      cacheSessionTranscript: () => assert.fail("stale action must not replace the live cache"),
    }, "old");
    state = { ...state, ...change };
    pending.resolve([message("old")]);
    assert.equal(await read, null);
  }
});
