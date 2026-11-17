import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createNotificationAttentionSlice } = await import("../src/stores/slices/notification-attention-slice.ts");
const { api } = await import("../src/lib/api.ts");
const { createCatalogSlice } = await import("../src/stores/slices/catalog-slice.ts");
const { createCatalogRuntime } = await import("../src/stores/runtime/catalog-runtime.ts");

function wireCatalog(h) {
  h.set({ notifications: [], unreadNotificationCount: 0, sessionOutcomes: {},
    ...createCatalogSlice({ get: h.get, set: h.set, catalogRuntime: createCatalogRuntime(),
      sessionRuntime: {}, decorateSessions: (rows) => rows,
      withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    }) });
}
const completion = (id, sessionId = "a") => ({ id, sessionId, sessionTitle: sessionId,
  kind: "task.completed", turnId: id, createdAt: "2026-11-16T00:00:00Z" });
function harness() {
  let state = { pendingCompletions: [], pendingCompletionCount: 0, pendingAsks: {},
    pendingPermissions: {}, dismissedNotificationRequests: {},
    markNotificationRead: (id) => api.markNotificationRead(id),
    sessions: [{ id: "a" }, { id: "b" }], page: "chat", activeSessionId: undefined,
    selectingSessionId: undefined, restorePendingInteractive: async () => {},
    refreshNotifications: async () => {} };
  const get = () => state;
  const set = (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
  Object.assign(state, createNotificationAttentionSlice({ get, set }));
  return { get, set };
}
const snapshot = (rows) => ({ notifications: [], unreadCount: 0,
  pendingCompletions: rows, pendingCompletionCount: rows.length });
function visible(t, focused = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const fixture = { visibilityState: "visible", hasFocus: () => focused };
  Object.defineProperty(globalThis, "document", { value: fixture, configurable: true });
  t.after(() => previous ? Object.defineProperty(globalThis, "document", previous) : delete globalThis.document);
  return fixture;
}

test("refresh restores asks in every session without navigation or modifying original notifications", async (t) => {
  const h = harness(), restored = [];
  t.mock.method(api, "listNotifications", async () => snapshot([completion("old")]));
  h.set({ restorePendingInteractive: async (id) => restored.push(id) });
  await h.get().refreshNotificationAttention();
  assert.deepEqual(restored, ["a", "b"]);
  assert.equal(h.get().activeSessionId, undefined);
  assert.equal(h.get().pendingCompletions[0].id, "old");
});

test("a completion arriving during refresh is not overwritten by an older snapshot", async (t) => {
  const h = harness(); let release;
  t.mock.method(api, "listNotifications", () => release
    ? Promise.resolve(snapshot([completion("new", "b"), completion("old")]))
    : new Promise((resolve) => { release = resolve; }));
  const read = h.get().refreshNotificationAttention();
  h.get().receiveCompletionNotification(completion("new", "b"));
  release(snapshot([completion("old")])); await read;
  assert.deepEqual(h.get().pendingCompletions.map((row) => row.id), ["new", "old"]);
  assert.equal(h.get().pendingCompletionCount, 2);
});

test("opening the bell, settings, a hidden chat, or loading another chat never confirms completion", async (t) => {
  const h = harness(), reads = [];
  const document = visible(t, false);
  t.mock.method(api, "markNotificationRead", async (...args) => { reads.push(args); return { ok: true }; });
  h.get().receiveCompletionNotification(completion("done"));
  h.set({ activeSessionId: "a" }); await h.get().acknowledgeVisibleCompletions();
  document.hasFocus = () => true; h.set({ page: "settings" }); await h.get().acknowledgeVisibleCompletions();
  h.set({ page: "chat", selectingSessionId: "b" }); await h.get().acknowledgeVisibleCompletions();
  h.set({ selectingSessionId: undefined, activeSessionId: "b" }); await h.get().acknowledgeVisibleCompletions();
  assert.deepEqual(reads, []);
  assert.equal(h.get().pendingCompletions.length, 1);
});

test("only the visible successfully loaded conversation confirms its own completion; asks stay pending", async (t) => {
  const h = harness(), reads = []; visible(t);
  h.set({ activeSessionId: "a", pendingAsks: { a: [{ requestId: "unanswered" }] } });
  h.get().receiveCompletionNotification(completion("a-done"));
  h.get().receiveCompletionNotification(completion("b-done", "b"));
  t.mock.method(api, "markNotificationRead", async (...args) => { reads.push(args); return { ok: true }; });
  t.mock.method(api, "listNotifications", async () => snapshot([completion("b-done", "b")]));
  await h.get().acknowledgeVisibleCompletions();
  assert.deepEqual(reads, [["a-done"]]);
  assert.deepEqual(h.get().pendingCompletions.map((row) => row.id), ["b-done"]);
  assert.equal(h.get().pendingAsks.a[0].requestId, "unanswered");
});

test("confirmation failure leaves attention available for retry", async (t) => {
  const h = harness(); visible(t); h.set({ activeSessionId: "a" });
  h.get().receiveCompletionNotification(completion("done"));
  t.mock.method(api, "markNotificationRead", async () => { throw new Error("unavailable"); });
  await assert.rejects(h.get().acknowledgeVisibleCompletions(), /unavailable/);
  assert.equal(h.get().pendingCompletions[0].id, "done");
});

test("late confirmation never removes a newly completed turn in the same chat", async (t) => {
  const h = harness(); visible(t); h.set({ activeSessionId: "a" });
  h.get().receiveCompletionNotification(completion("old")); let finish;
  t.mock.method(api, "markNotificationRead", () => new Promise((resolve) => { finish = resolve; }));
  t.mock.method(api, "listNotifications", async () => snapshot([completion("new")]));
  const ack = h.get().acknowledgeVisibleCompletions();
  h.get().receiveCompletionNotification(completion("new"));
  finish({ ok: true }); await ack;
  assert.deepEqual(h.get().pendingCompletions.map((row) => row.id), ["new"]);
});

test("completion pages deduplicate rows and keep a total separate from the bell badge", async (t) => {
  const h = harness(); h.get().receiveCompletionNotification(completion("first"));
  t.mock.method(api, "listNotifications", async (input) => {
    assert.equal(input.completionOffset, 1);
    return { ...snapshot([completion("first"), completion("second")]), pendingCompletionCount: 3 };
  });
  await h.get().loadMoreCompletionNotifications();
  assert.deepEqual(h.get().pendingCompletions.map((row) => row.id), ["first", "second"]);
  assert.equal(h.get().pendingCompletionCount, 3);
});

test("opening a chat confirms its completion beyond the first loaded page", async (t) => {
  const h = harness(), reads = []; visible(t);
  const others = Array.from({ length: 200 }, (_, index) => completion(`other-${index}`, "b"));
  h.set({ activeSessionId: "a", pendingCompletions: others, pendingCompletionCount: 201 });
  t.mock.method(api, "listNotifications", async (input) => ({
    ...snapshot(input.completionOffset === 200 ? [completion("unloaded")] : others),
    pendingCompletionCount: reads.length ? 200 : 201,
  }));
  t.mock.method(api, "markNotificationRead", async (...args) => { reads.push(args); return { ok: true }; });
  await h.get().acknowledgeVisibleCompletions();
  assert.deepEqual(reads, [["unloaded"]]);
  assert.equal(h.get().pendingCompletionCount, 200);
  assert.equal(h.get().pendingCompletions.length, 200);
});

test("selection does not acknowledge a completion before its conversation loads", async (t) => {
  const h = harness(); wireCatalog(h);
  const done = completion("done");
  h.set({ notifications: [done], unreadNotificationCount: 1, selectingSessionId: "a" });
  const reads = [];
  t.mock.method(api, "markNotificationRead", async (id) => { reads.push(id); return { ok: true }; });
  await h.get().acknowledgeSessionOutcome("a");
  assert.deepEqual(reads, []);
  assert.equal(h.get().unreadNotificationCount, 1);
});

test("completion acknowledgement invalidates older ordinary notification snapshots", async (t) => {
  const h = harness(); wireCatalog(h); visible(t);
  const done = completion("done");
  h.set({ activeSessionId: "a", notifications: [done], unreadNotificationCount: 1 });
  h.get().receiveCompletionNotification(done);
  let release;
  t.mock.method(api, "listNotifications", () => release
    ? Promise.resolve(snapshot([]))
    : new Promise((resolve) => { release = resolve; }));
  t.mock.method(api, "markNotificationRead", async () => ({ ok: true }));
  const oldRead = h.get().refreshNotifications();
  await h.get().acknowledgeVisibleCompletions();
  release({ ...snapshot([done]), notifications: [done], unreadCount: 1 });
  await oldRead;
  assert.equal(h.get().pendingCompletionCount, 0);
  assert.equal(h.get().unreadNotificationCount, 0);
});

test("a live completion included in an in-flight page is not counted twice", async (t) => {
  const h = harness();
  const rows = Array.from({ length: 201 }, (_, index) => completion(`old-${index}`, "b"));
  h.set({ pendingCompletions: rows.slice(0, 200), pendingCompletionCount: rows.length });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(api, "listNotifications", async (input) => {
    await gate;
    return { ...snapshot(rows.slice(input.completionOffset, input.completionOffset + 200)),
      pendingCompletionCount: rows.length };
  });
  const page = h.get().loadMoreCompletionNotifications();
  const fresh = completion("fresh", "b");
  rows.unshift(fresh);
  h.get().receiveCompletionNotification(fresh);
  release(); await page;
  assert.equal(h.get().pendingCompletions.length, 202);
  assert.equal(h.get().pendingCompletionCount, 202);
});

test("acknowledging pruned completion history does not decrement an unrelated unread failure", async (t) => {
  const h = harness(); wireCatalog(h);
  h.set({ notifications: [{ ...completion("failure", "b"), kind: "task.failed" }], unreadNotificationCount: 1 });
  t.mock.method(api, "markNotificationRead", async () => ({ ok: true }));
  await h.get().markNotificationRead("pruned-completion");
  assert.equal(h.get().unreadNotificationCount, 1);
  assert.equal(h.get().notifications[0].readAt, undefined);
});
