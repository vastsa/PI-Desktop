import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createNotificationAttentionSlice } = await import("../src/stores/slices/notification-attention-slice.ts");
const { createCatalogSlice } = await import("../src/stores/slices/catalog-slice.ts");
const { createCatalogRuntime } = await import("../src/stores/runtime/catalog-runtime.ts");
const { api } = await import("../src/lib/api.ts");
const completion = (id, sessionId = "a") => ({ id, sessionId, sessionTitle: sessionId,
  kind: "task.completed", turnId: id, createdAt: "2026-11-16T00:00:00Z" });
function harness() {
  let state = { notifications: [], unreadNotificationCount: 0, sessionOutcomes: {},
    pendingAsks: {}, pendingPermissions: {}, dismissedNotificationRequests: {},
    sessions: [{ id: "a" }, { id: "b" }], page: "chat", activeSessionId: undefined,
    selectingSessionId: undefined, restorePendingInteractive: async () => {} };
  const get = () => state;
  const set = (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
  Object.assign(state, createCatalogSlice({ get, set, catalogRuntime: createCatalogRuntime(),
    sessionRuntime: {}, decorateSessions: (rows) => rows,
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
  }), createNotificationAttentionSlice({ get, set }));
  return { get, set };
}
const snapshot = (rows) => ({ notifications: rows,
  unreadCount: rows.filter((row) => !row.readAt).length });
function visible(t, focused = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const fixture = { visibilityState: "visible", hasFocus: () => focused };
  Object.defineProperty(globalThis, "document", { value: fixture, configurable: true });
  t.after(() => previous ? Object.defineProperty(globalThis, "document", previous) : delete globalThis.document);
  return fixture;
}

test("refresh restores asks in every session and uses only the existing history response", async (t) => {
  const h = harness(), restored = [];
  t.mock.method(api, "listNotifications", async (input) => {
    assert.deepEqual(input, { limit: 200 });
    return snapshot([completion("old")]);
  });
  h.set({ restorePendingInteractive: async (id) => restored.push(id) });
  await h.get().refreshNotificationAttention();
  assert.deepEqual(restored, ["a", "b"]);
  assert.equal(h.get().activeSessionId, undefined);
  assert.equal(h.get().notifications[0].id, "old");
  assert.equal(h.get().unreadNotificationCount, 1);
});

test("a completion arriving during refresh is not overwritten by an older history snapshot", async (t) => {
  const h = harness(); let release;
  const fresh = completion("new", "b");
  t.mock.method(api, "listNotifications", () => release
    ? Promise.resolve(snapshot([fresh, completion("old")]))
    : new Promise((resolve) => { release = resolve; }));
  const read = h.get().refreshNotificationAttention();
  h.get().receiveNotification(fresh);
  release(snapshot([completion("old")])); await read;
  assert.deepEqual(h.get().notifications.map((row) => row.id), ["new"]);
  await h.get().refreshNotificationAttention();
  assert.deepEqual(h.get().notifications.map((row) => row.id), ["new", "old"]);
  assert.equal(h.get().unreadNotificationCount, 2);
});

test("opening the bell, settings, a hidden chat, or loading another chat never confirms completion", async (t) => {
  const h = harness(), reads = [];
  const document = visible(t, false);
  t.mock.method(api, "markNotificationRead", async (id) => { reads.push(id); return { ok: true }; });
  h.get().receiveNotification(completion("done"));
  h.set({ activeSessionId: "a" }); await h.get().acknowledgeVisibleCompletions();
  document.hasFocus = () => true; h.set({ page: "settings" }); await h.get().acknowledgeVisibleCompletions();
  h.set({ page: "chat", selectingSessionId: "b" }); await h.get().acknowledgeVisibleCompletions();
  h.set({ selectingSessionId: undefined, activeSessionId: "b" }); await h.get().acknowledgeVisibleCompletions();
  assert.deepEqual(reads, []);
  assert.equal(h.get().notifications[0].readAt, undefined);
});

test("only the visible loaded conversation confirms its own completion through ordinary history", async (t) => {
  const h = harness(), reads = []; visible(t);
  h.set({ activeSessionId: "a", pendingAsks: { a: [{ requestId: "unanswered" }] } });
  h.get().receiveNotification(completion("a-done"));
  h.get().receiveNotification(completion("b-done", "b"));
  t.mock.method(api, "markNotificationRead", async (id) => { reads.push(id); return { ok: true }; });
  await h.get().acknowledgeVisibleCompletions();
  assert.deepEqual(reads, ["a-done"]);
  assert.equal(h.get().unreadNotificationCount, 1);
  assert.equal(h.get().notifications.find((row) => row.id === "b-done").readAt, undefined);
  assert.ok(h.get().notifications.find((row) => row.id === "a-done").readAt);
  assert.equal(h.get().pendingAsks.a[0].requestId, "unanswered");
});

test("confirmation failure leaves unread history available for retry", async (t) => {
  const h = harness(); visible(t); h.set({ activeSessionId: "a" });
  h.get().receiveNotification(completion("done"));
  t.mock.method(api, "listNotifications", async () => snapshot([completion("done")]));
  t.mock.method(api, "markNotificationRead", async () => { throw new Error("unavailable"); });
  await assert.rejects(h.get().acknowledgeVisibleCompletions(), /unavailable/);
  assert.equal(h.get().notifications[0].readAt, undefined);
  assert.equal(h.get().unreadNotificationCount, 1);
});

test("late confirmation never reads a newly completed turn in the same chat", async (t) => {
  const h = harness(); visible(t); h.set({ activeSessionId: "a" });
  h.get().receiveNotification(completion("old")); let finish;
  t.mock.method(api, "markNotificationRead", () => new Promise((resolve) => { finish = resolve; }));
  const ack = h.get().acknowledgeVisibleCompletions();
  h.get().receiveNotification(completion("new"));
  finish({ ok: true }); await ack;
  assert.equal(h.get().notifications.find((row) => row.id === "new").readAt, undefined);
  assert.ok(h.get().notifications.find((row) => row.id === "old").readAt);
  assert.equal(h.get().unreadNotificationCount, 1);
});

test("selection does not acknowledge a completion before its conversation loads", async (t) => {
  const h = harness(), reads = [];
  h.get().receiveNotification(completion("done"));
  h.set({ selectingSessionId: "a" });
  t.mock.method(api, "markNotificationRead", async (id) => { reads.push(id); return { ok: true }; });
  await h.get().acknowledgeSessionOutcome("a");
  assert.deepEqual(reads, []);
  assert.equal(h.get().unreadNotificationCount, 1);
});

test("completion acknowledgement invalidates older ordinary notification snapshots", async (t) => {
  const h = harness(); visible(t); h.set({ activeSessionId: "a" });
  const done = completion("done"); h.get().receiveNotification(done);
  let release;
  t.mock.method(api, "listNotifications", () => new Promise((resolve) => { release = resolve; }));
  t.mock.method(api, "markNotificationRead", async () => ({ ok: true }));
  const oldRead = h.get().refreshNotifications();
  await h.get().acknowledgeVisibleCompletions();
  release(snapshot([done])); await oldRead;
  assert.ok(h.get().notifications[0].readAt);
  assert.equal(h.get().unreadNotificationCount, 0);
});

test("bulk read acknowledges completion-only history without individual reads and permits future events", async (t) => {
  const h = harness(); h.get().receiveNotification(completion("done"));
  t.mock.method(api, "markAllNotificationsRead", async () => ({ ok: true }));
  t.mock.method(api, "markNotificationRead", async () => { throw new Error("unexpected individual read"); });
  await h.get().markAllNotificationsRead();
  assert.equal(h.get().unreadNotificationCount, 0);
  assert.ok(h.get().notifications[0].readAt);
  h.get().receiveNotification({ ...completion("fresh"), createdAt: new Date(Date.now() + 10_000).toISOString() });
  assert.equal(h.get().unreadNotificationCount, 1);
});

test("request dismissal retains pending decisions and prunes only obsolete IDs", () => {
  const h = harness();
  const ask = { requestId: "question" }, permission = { requestId: "permission" };
  h.set({ pendingAsks: { a: [ask] }, pendingPermissions: { b: [permission] } });
  h.get().dismissNotificationRequests(["question", "permission"]);
  assert.deepEqual(h.get().dismissedNotificationRequests, { question: true, permission: true });
  assert.equal(h.get().pendingAsks.a[0], ask);
  assert.equal(h.get().pendingPermissions.b[0], permission);
  h.set({ pendingAsks: { a: [{ requestId: "fresh" }] } });
  h.get().dismissNotificationRequests([]);
  assert.deepEqual(h.get().dismissedNotificationRequests, { permission: true });
});

test("pruned completion IDs do not decrement an unrelated unread failure", async (t) => {
  const h = harness(); h.get().receiveNotification({ ...completion("failure", "b"), kind: "task.failed" });
  t.mock.method(api, "markNotificationRead", async () => { throw new Error("pruned history must not be read"); });
  await h.get().markNotificationRead("pruned-completion");
  assert.equal(h.get().unreadNotificationCount, 1);
  assert.equal(h.get().notifications[0].readAt, undefined);
});

test("live completion history and its unread count obey the same 200-row retention cap", () => {
  const h = harness();
  for (let index = 0; index < 201; index++) h.get().receiveNotification(completion(`done-${index}`));
  assert.equal(h.get().notifications.length, 200);
  assert.equal(h.get().unreadNotificationCount, 200);
  assert.equal(h.get().notifications.some((row) => row.id === "done-0"), false);
});
