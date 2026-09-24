import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { observeSessionCollaboration } from "../src/features/sessions/session-collaboration-reader.ts";
import {
  collaborationStatusKey,
  currentCollaborationResult,
  formatSessionTimestamp,
  positionSessionHoverCard,
  sessionPreview,
  sessionReferenceIsRunning,
} from "../src/features/sessions/session-collaboration-view.ts";

const summary = (overrides = {}) => ({
  sessionId: "worker-session",
  title: "Worker",
  status: "completed",
  observedAt: "2026-09-13T12:00:00.000Z",
  recentExchanges: [],
  ...overrides,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a visible card reads serially and stops reading after dismissal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const second = deferred();
  const readings = [first, second];
  const received = [];
  let calls = 0;
  const stop = observeSessionCollaboration({
    sessionId: "worker-session",
    read: (id) => {
      assert.equal(id, "worker-session");
      return readings[calls++].promise;
    },
    onSummary: (value) => received.push(value),
    onUnavailable: () => {},
  });
  t.after(stop);
  assert.equal(calls, 1);
  // Below the hard deadline a hung read is never overlapped.
  t.mock.timers.tick(14_000);
  assert.equal(calls, 1, "slow reads must not overlap");
  first.resolve(summary());
  await setImmediate();
  assert.equal(received.length, 1);
  t.mock.timers.tick(3_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
  stop();
  second.resolve(summary({ status: "running" }));
  await setImmediate();
  t.mock.timers.tick(20_000);
  assert.equal(calls, 2);
  assert.equal(received.length, 1, "dismissed cards must ignore late responses");
});

test("retargeted cards ignore both a stale success and a stale failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const outcome of ["resolve", "reject"]) {
    const pending = deferred();
    const events = [];
    const stop = observeSessionCollaboration({
      sessionId: "worker-session",
      read: () => pending.promise,
      onSummary: () => events.push("summary"),
      onUnavailable: () => events.push("unavailable"),
    });
    stop();
    if (outcome === "resolve") pending.resolve(summary());
    else pending.reject(new Error("late failure"));
    await setImmediate();
    t.mock.timers.tick(10_000);
    assert.deepEqual(events, []);
  }
});

test("slow or failed reads show unavailable without claiming idle or completed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const events = [];
  const stop = observeSessionCollaboration({
    sessionId: "worker-session",
    read: () => pending.promise,
    onSummary: (value) => events.push(value.status),
    onUnavailable: () => events.push("unavailable"),
  });
  t.after(stop);
  t.mock.timers.tick(5_000);
  assert.deepEqual(events, ["unavailable"]);
  pending.resolve(summary({ status: "waiting_permission" }));
  await setImmediate();
  assert.deepEqual(events, ["unavailable", "waiting_permission"]);
});

test("a response for another session cannot replace the hovered session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const received = [];
  const stop = observeSessionCollaboration({
    sessionId: "worker-session",
    read: async () => summary({ sessionId: "unrelated-session" }),
    onSummary: (value) => received.push(value),
    onUnavailable: () => received.push("unavailable"),
  });
  t.after(stop);
  await setImmediate();
  assert.deepEqual(received, ["unavailable"]);
});

test("hidden or detached cards do not poll again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = true;
  let calls = 0;
  const stop = observeSessionCollaboration({
    sessionId: "worker-session",
    read: async () => { calls++; return summary(); },
    onSummary: () => {},
    onUnavailable: () => {},
    isVisible: () => visible,
  });
  t.after(stop);
  await setImmediate();
  visible = false;
  t.mock.timers.tick(20_000);
  assert.equal(calls, 1);
});

test("a read that never settles is abandoned, reschedules, and cannot report late", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hung = [deferred(), deferred()];
  const events = [];
  let calls = 0;
  const stop = observeSessionCollaboration({
    sessionId: "worker-session",
    read: () => hung[calls++].promise,
    onSummary: (value) => events.push(value.status),
    onUnavailable: () => events.push("unavailable"),
  });
  t.after(stop);
  t.mock.timers.tick(5_000);
  assert.deepEqual(events, ["unavailable"]);
  t.mock.timers.tick(10_000);
  assert.deepEqual(events, ["unavailable"], "the hard deadline does not report twice");
  assert.equal(calls, 1, "the abandoned read is never overlapped before the deadline");
  t.mock.timers.tick(4_000);
  assert.equal(calls, 2, "the abandoned iteration schedules the next read");
  hung[0].resolve(summary({ status: "completed" }));
  await setImmediate();
  assert.deepEqual(events, ["unavailable"], "a late result of an abandoned read is ignored");
});

test("a hidden card reschedules at the idle interval and reads again when it returns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false;
  let calls = 0;
  const received = [];
  const stop = observeSessionCollaboration({
    sessionId: "worker-session",
    read: async () => { calls++; return summary(); },
    onSummary: (value) => received.push(value.sessionId),
    onUnavailable: () => received.push("unavailable"),
    isVisible: () => visible,
  });
  t.after(stop);
  await setImmediate();
  assert.equal(calls, 0, "a hidden card does not read");
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 0, "an idle card keeps rescheduling without reading");
  visible = true;
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1, "the next idle attempt reads once the card is visible again");
  await setImmediate();
  assert.deepEqual(received, ["worker-session"]);
  visible = false;
  t.mock.timers.tick(4_000);
  assert.equal(calls, 1, "becoming hidden stops the reads after the current one");
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
});

test("an unknown host status falls back to the shared unknown label", () => {
  assert.equal(collaborationStatusKey("status-from-a-newer-host"), "sessionCollaboration.statusUnknown");
  assert.equal(collaborationStatusKey("completed"), "sessionCollaboration.statusCompleted");
});

test("related session references expose only active runtime state", () => {
  const reference = { sessionId: "worker-session", title: "Worker" };
  assert.equal(sessionReferenceIsRunning(reference, { "worker-session": true }), true);
  assert.equal(sessionReferenceIsRunning(reference, { "worker-session": false }), false);
  assert.equal(sessionReferenceIsRunning(reference, {}), false);
  assert.equal(sessionReferenceIsRunning(reference, { "worker-session": true }, { "worker-session": [{}] }), false);
});

test("a reused worker displays only the current settled request's result", () => {
  const currentTask = { messageId: "new-request", status: "completed", turnId: "new-turn" };
  const result = { messageId: "new-request", status: "completed", turnId: "new-turn", text: "New report" };
  assert.equal(currentCollaborationResult(summary({ currentTask, result })), result);
  assert.equal(currentCollaborationResult(summary({ currentTask, result: { ...result, messageId: "old-request" } })), undefined);
  assert.equal(currentCollaborationResult(summary({ currentTask, result: { ...result, turnId: "old-turn" } })), undefined);
  for (const status of ["running", "queued", "waiting_permission"]) {
    assert.equal(currentCollaborationResult(summary({ currentTask, result, status })), undefined);
  }
});

test("previews remain bounded plain text and invalid timestamps stay unknown", () => {
  assert.equal(sessionPreview("  A\n  multi-line  task  "), "A multi-line task");
  assert.equal(sessionPreview("A".repeat(1_000), 8), "AAAAAAAA…");
  assert.equal(sessionPreview(undefined), "");
  assert.equal(formatSessionTimestamp("not a timestamp", "en"), "—");
  for (const status of ["idle", "queued", "running", "waiting_permission", "completed", "failed", "cancelled", "interrupted"]) {
    assert.match(collaborationStatusKey(status), /^sessionCollaboration\.status/);
  }
});

test("hover placement measures content and stays inside narrow or short windows", () => {
  const anchor = { top: 300, bottom: 330, left: 12, right: 280 };
  assert.deepEqual(positionSessionHoverCard(anchor, { width: 320, height: 168 }, { width: 1_200, height: 800 }), { left: 12, top: 336 });
  assert.deepEqual(positionSessionHoverCard(anchor, { width: 320, height: 168 }, { width: 1_200, height: 460 }), { left: 12, top: 126 });
  const tall = positionSessionHoverCard(anchor, { width: 320, height: 400 }, { width: 1_200, height: 600 });
  assert.equal(tall.left, 286, "a tall card uses the row's side instead of covering it");
  assert.ok(tall.top >= 8 && tall.top + 400 <= 592);
  assert.deepEqual(positionSessionHoverCard(anchor, { width: 284, height: 400 }, { width: 300, height: 420 }), { left: 8, top: 12 });
});
