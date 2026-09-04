import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RETAINED_SESSION_PANE_LIMIT,
  clearSessionPanes,
  recordPaneTranscript,
  releaseSessionPane,
  retainSessionPane,
} from "../src/lib/session-panes.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const store = await read("../src/stores/app-store.ts");

const empty = { retainedSessionIds: [], retainedTranscripts: {} };
const say = (id) => [{ id: `${id}-1`, role: "user", content: id }];

function visit(state, ids) {
  return ids.reduce(
    (current, id) => retainSessionPane(current, id, say(id)),
    state,
  );
}

test("the visited session becomes the visible pane", () => {
  const state = retainSessionPane(empty, "a", say("a"));
  assert.deepEqual(state.retainedSessionIds, ["a"]);
  assert.deepEqual(state.retainedTranscripts.a, say("a"));
});

test("returning to a session promotes its pane without rebuilding it", () => {
  const painted = say("a");
  const state = visit(retainSessionPane(empty, "a", painted), ["b"]);
  const back = retainSessionPane(state, "a", state.retainedTranscripts.a);
  assert.deepEqual(back.retainedSessionIds, ["a", "b"]);
  // Identity is what lets the pane skip re-rendering: a warm return must hand
  // the pane the very array it was already showing.
  assert.strictEqual(back.retainedTranscripts.a, painted);
});

test("retention is bounded and evicts the least recently visible pane", () => {
  const state = visit(empty, ["a", "b", "c", "d"]);
  assert.equal(state.retainedSessionIds.length, RETAINED_SESSION_PANE_LIMIT);
  assert.deepEqual(state.retainedSessionIds, ["d", "c", "b"]);
  // The evicted pane's transcript goes with it, so a return to `a` is a cold
  // open rather than a reveal of a snapshot with no pane behind it.
  assert.equal(state.retainedTranscripts.a, undefined);
  assert.equal(Object.keys(state.retainedTranscripts).length, 3);
});

test("re-visiting the visible session changes nothing", () => {
  const state = visit(empty, ["a", "b"]);
  const again = retainSessionPane(state, "b", state.retainedTranscripts.b);
  // Every retained pane subscribes to this state, so an unchanged result must
  // keep its identity or a single store write re-renders all of them.
  assert.strictEqual(again.retainedSessionIds, state.retainedSessionIds);
  assert.strictEqual(again.retainedTranscripts, state.retainedTranscripts);
});

test("a visit with no session id leaves retention untouched", () => {
  const state = visit(empty, ["a"]);
  assert.strictEqual(retainSessionPane(state, undefined, []), state);
});

test("releasing a pane drops it and its transcript", () => {
  const state = visit(empty, ["a", "b"]);
  const released = releaseSessionPane(state, "a");
  assert.deepEqual(released.retainedSessionIds, ["b"]);
  assert.equal(released.retainedTranscripts.a, undefined);
  assert.deepEqual(released.retainedTranscripts.b, say("b"));
});

test("releasing an unretained session is a no-op", () => {
  const state = visit(empty, ["a"]);
  assert.strictEqual(releaseSessionPane(state, "zzz"), state);
});

test("leaving the chat with no session drops every pane", () => {
  // Switching or clearing the project makes the retained sessions unreachable.
  // A pane left behind would stay on screen as the visible pane and suppress
  // the empty state, showing the previous project's conversation.
  const cleared = clearSessionPanes();
  assert.deepEqual(cleared.retainedSessionIds, []);
  assert.deepEqual(cleared.retainedTranscripts, {});
});

test("the store drops panes wherever it clears the active session", () => {
  // Each of these paths sets `activeSessionId: undefined` with `messages: []`:
  // bootstrap with no persisted session, activateProject, openProject,
  // clearProject, and New Task's first-frame empty reveal (D305). All of them
  // must release retention in the same commit. Intermediate fields such as
  // `draftConfiguration` or `selectingSessionId` do not exempt a path.
  const clearing =
    store.match(
      /activeSessionId: undefined,(?:\n\s*(?:draftConfiguration: null|selectingSessionId: undefined),)*\n\s*messages: \[\],/g,
    ) ?? [];
  const releasing = store.match(/\.\.\.clearSessionPanes\(\),/g) ?? [];
  assert.equal(
    releasing.length,
    clearing.length,
    "every path that clears the active session must also clear the panes",
  );
});

test("the visible pane's snapshot follows what it last painted", () => {
  const state = visit(empty, ["a"]);
  const streamed = [...say("a"), { id: "a-2", role: "assistant", content: "hi" }];
  const recorded = recordPaneTranscript(state, "a", streamed);
  assert.strictEqual(recorded.retainedTranscripts.a, streamed);
  // Leaving the session must show what it last painted, not what it opened with.
  const left = retainSessionPane(recorded, "b", say("b"));
  assert.strictEqual(left.retainedTranscripts.a, streamed);
});

test("an evicted session's stream cannot resurrect its pane", () => {
  const state = visit(empty, ["a", "b", "c", "d"]);
  assert.strictEqual(recordPaneTranscript(state, "a", say("a")), state);
});

test("recording the same transcript twice keeps state identity", () => {
  const state = visit(empty, ["a"]);
  assert.strictEqual(
    recordPaneTranscript(state, "a", state.retainedTranscripts.a),
    state,
  );
});

test("the store keeps the retained panes in step with the live projection", () => {
  // `messages` is written from many places (streaming, edits, retries, smart
  // stop). One subscription mirrors it so none of them has to know about panes.
  assert.match(store, /useAppStore\.subscribe\(\(state, previous\) => \{/);
  assert.match(store, /recordPaneTranscript\(current, id, current\.messages\)/);
  // Deleting a session must release its pane, or the surface keeps a pane for a
  // session that no longer exists.
  assert.match(store, /\.\.\.releaseSessionPane\(state, id\)/);
  assert.match(store, /retainedSessionIds: \[\],/);
  assert.match(store, /retainedTranscripts: \{\},/);
});
