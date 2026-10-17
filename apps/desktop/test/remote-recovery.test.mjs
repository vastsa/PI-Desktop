import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostConnection } = await import("../electron/main/remote/remote-host-connection.ts");

const deferred = () => Promise.withResolvers();
const flush = () => new Promise(resolve => setImmediate(resolve));
const session = id => ({ id, title: id, status: "idle", planningState: "inactive", mode: "agent", permissionMode: "default", queuedTurnIds: [], revision: 1, createdAt: "2026-09-18T10:00:00Z", updatedAt: "2026-09-18T10:00:00Z" });
function snapshot(id, sequence = 0, epoch = "ep") {
  return { session: session(id), pendingApprovals: [], pendingInputs: [], cursor: { epoch, sequence }, revision: 1, generatedAt: "2026-09-18T10:00:00Z", items: [], activeItems: [], queuedTurns: [], hasMoreHistory: false };
}
function setup(ids = ["s1"]) {
  const calls = [], events = [], warnings = [];
  const listeners = new Set(), reconnects = new Set(), states = new Set(), closes = new Set();
  const overrides = new Map();
  const snapshots = new Map(ids.map(id => [id, snapshot(id)]));
  let count = 0;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (overrides.has(method)) return overrides.get(method)(params);
      if (method === "session/list") return { sessions: ids.map(session) };
      if (method === "session/attach") return { snapshot: snapshots.get(params.sessionId) ?? snapshot(params.sessionId) };
      if (method === "events/subscribe") return { subscriptionId: `sub${++count}`, replayComplete: true, starting: { epoch: "ep", sequence: 1 } };
      return { ok: true };
    },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    subscribeReconnect: fn => { reconnects.add(fn); return () => reconnects.delete(fn); },
    subscribeState: fn => { states.add(fn); return () => states.delete(fn); },
    subscribeSubscriptionClosed: fn => { closes.add(fn); return () => closes.delete(fn); },
  };
  const router = createBackendRouter();
  const conn = createRemoteHostConnection({ hostKey: "h", client, router, emit: (channel, payload) => events.push({ channel, payload }), log: (...args) => warnings.push(args) });
  return { conn, client, router, calls, events, overrides, snapshots, listeners, reconnects, states, closes, warnings,
    push: e => { for (const fn of listeners) fn({ eventId: `e${e.sequence ?? "x"}`, scope: "session", sessionId: "s1", epoch: "ep", revision: 1, kind: "item.started", occurredAt: "2026-09-18T10:00:00Z", payload: { event: { type: "tool_start", toolCallId: "tc", toolName: "Read", args: {} } }, ...e }); },
    reconnect: async () => { for (const fn of reconnects) await fn(); },
    backend: id => router.resolveBackend(IPC.invoke.sessionGet, [{ id: `remote:h:${id}` }]),
  };
}

test("close during a pending list cannot register late sessions", async () => {
  const f = setup();
  const wait = deferred();
  f.overrides.set("session/list", () => wait.promise);
  const opening = f.conn.open();
  await flush();
  await f.conn.close();
  wait.resolve({ sessions: [session("s1")] });
  await opening.catch(() => undefined);
  assert.equal(f.backend("s1"), null);
  assert.equal(f.listeners.size, 0);
});

test("ensureSession is idempotent and closing invalidates pending subscription completion", async () => {
  const f = setup([]);
  await f.conn.open();
  const wait = deferred();
  f.overrides.set("events/subscribe", () => wait.promise);
  const first = f.conn.ensureSession("new");
  const second = f.conn.ensureSession("new");
  await flush();
  assert.equal(f.calls.filter(c => c.method === "events/subscribe" && c.params.sessionId === "new").length, 1);
  await f.conn.close();
  wait.resolve({ subscriptionId: "late", replayComplete: true, starting: { epoch: "ep", sequence: 1 } });
  await Promise.allSettled([first, second]);
  assert.equal(f.backend("new"), null);
  assert.equal(f.reconnects.size + f.states.size + f.closes.size, 0);
});

test("durable cursors are acknowledged and duplicate durable/ephemeral events are not emitted twice", async () => {
  const f = setup();
  await f.conn.open();
  f.push({ sequence: 1 }); f.push({ sequence: 1 });
  f.push({ kind: "item.delta", eventId: "delta", afterSequence: 1 });
  f.push({ kind: "item.delta", eventId: "delta", afterSequence: 1 });
  await flush();
  assert.equal(f.events.filter(e => e.channel === IPC.event.agentMessage).length, 2);
  const ack = f.calls.find(c => c.method === "events/ack");
  assert.ok(ack);
  assert.equal(ack.params.sequence, 1);
  await f.conn.close();
});

test("reconnect resubscribes host and sessions, restores pending prompts, then refreshes without mutations", async () => {
  const f = setup();
  await f.conn.open();
  f.push({ sequence: 2 });
  f.snapshots.set("s1", { ...snapshot("s1", 3), pendingApprovals: [{ id: "a1", kind: "tool", sessionId: "s1", turnId: "t1", revision: 1, summary: "read" }] });
  f.calls.length = 0; f.events.length = 0;
  await f.reconnect();
  assert.ok(f.calls.some(c => c.method === "events/subscribe" && c.params.scope === "host"));
  assert.ok(f.calls.some(c => c.method === "events/subscribe" && c.params.sessionId === "s1"));
  assert.ok(f.events.some(e => e.payload.event?.type === "tool_permission_request"));
  assert.equal(f.events.at(-1).channel, IPC.event.sessionsChanged);
  assert.ok(f.calls.every(c => ["session/list", "session/attach", "events/subscribe", "events/ack", "events/unsubscribe"].includes(c.method)));
  await f.conn.close();
});

test("resync.required and CLIENT_TOO_SLOW recover only the affected stream", async () => {
  const f = setup(["s1", "s2"]);
  await f.conn.open();
  f.calls.length = 0;
  f.push({ kind: "resync.required", sequence: 3 });
  await flush(); await flush();
  assert.deepEqual(f.calls.filter(c => c.method === "session/attach").map(c => c.params.sessionId), ["s1"]);
  const sub = f.calls.find(c => c.method === "events/subscribe");
  assert.ok(sub);
  f.calls.length = 0;
  for (const fn of f.closes) fn({ subscriptionId: "unowned-work-panel", error: { code: "CLIENT_TOO_SLOW" }, lastSafeCursor: { epoch: "ep", sequence: 3 } });
  await flush();
  assert.equal(f.calls.length, 0);
  await f.conn.close();
});

test("a broken session subscription rejects open and releases registrations", async () => {
  const f = setup();
  f.overrides.set("events/subscribe", p => { if (p.scope === "session") throw new Error("subscribe refused"); return { subscriptionId: "host", starting: { epoch: "ep", sequence: 1 }, replayComplete: true }; });
  await assert.rejects(f.conn.open(), /subscribe refused/);
  assert.equal(f.backend("s1"), null);
  assert.equal(f.listeners.size, 0);
});

test("many listed sessions register but do not exhaust the host's eight subscription slots", async () => {
  const f = setup(Array.from({ length: 20 }, (_, i) => `s${i}`));
  await f.conn.open();
  const subscribed = f.calls.filter(c => c.method === "events/subscribe");
  assert.ok(subscribed.length <= 8);
  assert.ok(f.backend("s19"));
  await f.conn.ensureSession("s19");
  assert.ok(f.calls.some(c => c.method === "events/subscribe" && c.params.sessionId === "s19"));
  await f.conn.close();
});

test("a server-closed owned subscription is snapshotted and resubscribed", async () => {
  const f = setup();
  await f.conn.open();
  f.calls.length = 0;
  for (const fn of f.closes) fn({ subscriptionId: "sub2", error: { code: "CLIENT_TOO_SLOW" }, lastSafeCursor: { epoch: "ep", sequence: 0 } });
  await flush();
  assert.ok(f.calls.some(c => c.method === "session/attach" && c.params.sessionId === "s1"));
  assert.ok(f.calls.some(c => c.method === "events/subscribe" && c.params.sessionId === "s1"));
  await f.conn.close();
});

test("expired cursor retries attach with a new epoch and acknowledges early replay", async () => {
  const f = setup([]);
  await f.conn.open();
  let attempts = 0;
  f.overrides.set("session/attach", () => ({ snapshot: snapshot("s1", 5, attempts ? "new-ep" : "ep") }));
  f.overrides.set("events/subscribe", () => {
    attempts++;
    if (attempts === 1) return { subscriptionId: "expired", replayComplete: false, starting: { epoch: "new-ep", sequence: 6 } };
    f.push({ sequence: 6, epoch: "new-ep" });
    return { subscriptionId: "fresh", replayComplete: true, starting: { epoch: "new-ep", sequence: 7 } };
  });
  await f.conn.ensureSession("s1");
  await flush();
  assert.equal(attempts, 2);
  assert.equal(f.events.filter(e => e.channel === IPC.event.agentMessage).length, 1);
  assert.ok(f.calls.some(c => c.method === "events/ack" && c.params.subscriptionId === "fresh" && c.params.sequence === 6));
  await f.conn.close();
});

test("close during recovery discards the delayed snapshot and sidebar refresh", async () => {
  const f = setup();
  await f.conn.open();
  const wait = deferred();
  f.overrides.set("session/attach", () => wait.promise);
  const recovering = f.reconnect();
  await flush();
  await f.conn.close();
  f.events.length = 0;
  wait.resolve({ snapshot: { ...snapshot("s1"), pendingApprovals: [{ id: "a", kind: "tool", sessionId: "s1" }] } });
  await recovering.catch(() => undefined);
  assert.deepEqual(f.events, []);
  assert.equal(f.backend("s1"), null);
});

test("archive while session/list is pending does not resurrect its stale list row", async () => {
  const f = setup();
  const wait = deferred();
  f.overrides.set("session/list", () => wait.promise);
  const opening = f.conn.open();
  await flush();
  f.push({ scope: "host", kind: "session.archived", sequence: 1, payload: { session: { id: "s1" } } });
  wait.resolve({ sessions: [session("s1")] });
  await opening;
  assert.equal(f.backend("s1"), null);
  await f.conn.close();
});

test("a backend snapshot already in flight when closed cannot restore a prompt", async () => {
  const f = setup();
  await f.conn.open();
  f.events.length = 0; // Ignore the initial authoritative interaction snapshot.
  const wait = deferred();
  f.overrides.set("session/attach", () => wait.promise);
  const request = f.backend("s1").invoke(IPC.invoke.sessionGet, [{ id: "remote:h:s1" }]);
  await flush();
  await f.conn.close();
  wait.resolve({ snapshot: snapshot("s1") });
  await assert.rejects(request, error => error.errorCode === "HOST_DISCONNECTED");
  assert.equal(f.events.length, 0);
});
