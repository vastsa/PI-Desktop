/**
 * A renderer reload forgets the decision cards: `pendingAsks` and
 * `pendingPermissions` live in renderer memory only. Main still holds the open
 * ask questions and the gated tool requests, so `restorePendingInteractive`
 * rebuilds the cards from that read — as a merge that never clears a queue.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { enqueueAsk } = await import("../src/lib/pending-asks.ts");
const { enqueuePermission } = await import("../src/lib/pending-permissions.ts");
const { api } = await import("../src/lib/api.ts");

const askFor = (sessionId, requestId) => ({
  sessionId,
  requestId,
  toolCallId: `tool-${requestId}`,
  questions: [{ question: "Which branch should I use?", options: [] }],
});

const permissionFor = (sessionId, requestId) => ({
  sessionId,
  requestId,
  toolCallId: `tool-${requestId}`,
  toolName: "shell",
});

const DEFAULT_SESSIONS = [
  { id: "session-a", source: "desktop", mode: "agent" },
  { id: "session-b", source: "desktop", mode: "agent" },
];

function harness({ sessions = DEFAULT_SESSIONS, pendingAsks = {}, pendingPermissions = {} } = {}) {
  const toasts = [];
  let state = {
    sessions,
    pendingAsks,
    pendingPermissions,
    planningStates: {},
    planCheckpoints: {},
    pendingPlans: {},
    runningSessions: {},
    showToast: (message) => toasts.push(message),
    restorePendingPlan: async () => "unavailable",
  };
  const access = {
    get: () => state,
    set: (update) => {
      state = {
        ...state,
        ...(typeof update === "function" ? update(state) : update),
      };
    },
  };
  const slice = createSessionSlice({
    ...access,
    runtime: {},
    decorateSessions: (entries) => entries,
    withoutRecordKey: (record, key) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    sessionModeForPlanningState: () => "agent",
    openPlanArtifact: () => {},
    rememberSessionCompactions: () => {},
    commitForkedSession: () => {},
    persistSessionAndSelect: async () => null,
  });
  Object.assign(state, slice);
  return { slice: state, get: access.get, set: access.set, toasts };
}

test("one ask and one permission come back as cards for the session", async (t) => {
  const h = harness();
  const reads = [];
  const pending = {
    asks: [askFor("session-a", "ask-1")],
    permissions: [permissionFor("session-a", "perm-1")],
  };
  t.mock.method(api, "pendingInteractive", async (sessionId) => {
    reads.push(sessionId);
    return pending;
  });

  await h.slice.restorePendingInteractive("session-a");

  assert.deepEqual(reads, ["session-a"]);
  assert.deepEqual(h.get().pendingAsks["session-a"], pending.asks);
  assert.deepEqual(h.get().pendingPermissions["session-a"], pending.permissions);
  assert.deepEqual(h.toasts, []);
});

test("restoring twice does not duplicate the same card", async (t) => {
  const h = harness();
  t.mock.method(api, "pendingInteractive", async () => ({
    asks: [askFor("session-a", "ask-1")],
    permissions: [permissionFor("session-a", "perm-1")],
  }));

  await h.slice.restorePendingInteractive("session-a");
  await h.slice.restorePendingInteractive("session-a");

  assert.equal(h.get().pendingAsks["session-a"].length, 1);
  assert.equal(h.get().pendingPermissions["session-a"].length, 1);
  assert.equal(h.get().pendingAsks["session-a"][0].requestId, "ask-1");
  assert.equal(h.get().pendingPermissions["session-a"][0].requestId, "perm-1");
});

test("an ask already queued by the live event stream is kept exactly once", async (t) => {
  const live = askFor("session-a", "ask-1");
  const h = harness({
    pendingAsks: enqueueAsk({}, live),
    pendingPermissions: enqueuePermission({}, permissionFor("session-a", "perm-live")),
  });
  t.mock.method(api, "pendingInteractive", async () => ({
    asks: [live, askFor("session-a", "ask-2")],
    permissions: [permissionFor("session-a", "perm-live")],
  }));

  await h.slice.restorePendingInteractive("session-a");

  assert.deepEqual(
    h.get().pendingAsks["session-a"].map((entry) => entry.requestId),
    ["ask-1", "ask-2"],
  );
  assert.deepEqual(
    h.get().pendingPermissions["session-a"].map((entry) => entry.requestId),
    ["perm-live"],
  );
});

test("a card delivered while the read was in flight is never removed", async (t) => {
  const h = harness();
  let releaseRead;
  const read = new Promise((resolve) => {
    releaseRead = () => resolve({
      asks: [askFor("session-a", "ask-restored")],
      permissions: [],
    });
  });
  t.mock.method(api, "pendingInteractive", () => read);

  const restore = h.slice.restorePendingInteractive("session-a");
  h.set((state) => ({
    pendingAsks: enqueueAsk(state.pendingAsks, askFor("session-a", "ask-live")),
  }));
  releaseRead();
  await restore;

  assert.deepEqual(
    h.get().pendingAsks["session-a"].map((entry) => entry.requestId),
    ["ask-live", "ask-restored"],
  );
});

test("another session's queues stay untouched", async (t) => {
  const otherAsk = askFor("session-b", "ask-b");
  const otherPermission = permissionFor("session-b", "perm-b");
  const h = harness({
    pendingAsks: enqueueAsk({}, otherAsk),
    pendingPermissions: enqueuePermission({}, otherPermission),
  });
  t.mock.method(api, "pendingInteractive", async () => ({
    asks: [askFor("session-a", "ask-1")],
    permissions: [permissionFor("session-a", "perm-1")],
  }));

  await h.slice.restorePendingInteractive("session-a");

  assert.deepEqual(h.get().pendingAsks["session-b"], [otherAsk]);
  assert.deepEqual(h.get().pendingPermissions["session-b"], [otherPermission]);
  assert.equal(h.get().pendingAsks["session-a"][0].requestId, "ask-1");
  assert.equal(h.get().pendingPermissions["session-a"][0].requestId, "perm-1");
});

test("an empty read is a no-op for cards the user can still answer", async (t) => {
  const liveAsk = askFor("session-a", "ask-live");
  const h = harness({
    pendingAsks: enqueueAsk({}, liveAsk),
    pendingPermissions: enqueuePermission({}, permissionFor("session-a", "perm-live")),
  });
  t.mock.method(api, "pendingInteractive", async () => ({ asks: [], permissions: [] }));

  await h.slice.restorePendingInteractive("session-a");

  assert.deepEqual(h.get().pendingAsks["session-a"], [liveAsk]);
  assert.equal(h.get().pendingPermissions["session-a"].length, 1);
});

test("a rejected read leaves the queues exactly as the live stream left them", async (t) => {
  for (const failure of [
    () => Promise.reject(new Error("host RPC timeout: agent.pendingInteractive")),
    () => Promise.reject(new Error("piDesktop preload bridge unavailable")),
    () => Promise.reject({ code: "HOST_UNAVAILABLE" }),
  ]) {
    const liveAsk = askFor("session-a", "ask-live");
    const h = harness({
      pendingAsks: enqueueAsk({}, liveAsk),
      pendingPermissions: enqueuePermission({}, permissionFor("session-a", "perm-live")),
    });
    const before = {
      asks: h.get().pendingAsks,
      permissions: h.get().pendingPermissions,
    };
    t.mock.method(api, "pendingInteractive", failure);

    await h.slice.restorePendingInteractive("session-a");

    assert.equal(h.get().pendingAsks, before.asks, "the queue object must not be replaced");
    assert.equal(h.get().pendingPermissions, before.permissions);
    assert.deepEqual(h.get().pendingAsks["session-a"], [liveAsk]);
    assert.deepEqual(h.toasts, [], "a failed reload recovery is silent");
  }
});

test("native, remote, and unknown sessions never read the desktop queue", async (t) => {
  const h = harness({
    sessions: [
      { id: "native-pi:abc", source: "pi-native" },
      { id: "remote-9", source: "remote" },
      { id: "session-a", source: "desktop" },
    ],
  });
  const reads = [];
  t.mock.method(api, "pendingInteractive", async (sessionId) => {
    reads.push(sessionId);
    throw new Error("this session has no desktop queue");
  });

  await h.slice.restorePendingInteractive("native-pi:abc");
  await h.slice.restorePendingInteractive("remote-9");
  await h.slice.restorePendingInteractive("missing-session");
  await h.slice.restorePendingInteractive("");

  assert.deepEqual(reads, []);
  assert.deepEqual(h.get().pendingAsks, {});
  assert.deepEqual(h.get().pendingPermissions, {});
});

test("a session selection and the plan batch both call the restore", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");
  const [sessionSlice, coordination, appState] = await Promise.all([
    read("../src/stores/slices/session-slice.ts"),
    read("../src/stores/runtime/session-coordination.ts"),
    read("../src/stores/app-state.ts"),
  ]);

  assert.match(
    appState,
    /restorePendingInteractive: \(sessionId: string\) => Promise<void>;/,
  );
  // The plan batch after the session list loads restores both.
  assert.match(
    sessionSlice,
    /await get\(\)\.restorePendingPlan\(sessionId\);\n(?:.*\n)*?\s*await get\(\)\.restorePendingInteractive\(sessionId\);/,
  );
  // Opening a session, and the same place session-coordination restores plans.
  assert.match(sessionSlice, /void get\(\)\.restorePendingPlan\(id\);\n(?:.*\n)*?\s*void get\(\)\.restorePendingInteractive\(id\);/);
  assert.match(coordination, /void get\(\)\.restorePendingPlan\(summary\.id\);\n\s*void get\(\)\.restorePendingInteractive\(summary\.id\);/);
});
