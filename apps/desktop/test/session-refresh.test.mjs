import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRefreshCoordinator } = await import(
  "../src/lib/refresh-coordinator.ts"
);
const { createSessionSlice } = await import(
  "../src/stores/slices/session-slice.ts"
);
const { api } = await import("../src/lib/api.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledRead() {
  const requests = [];
  let active = 0;
  let peakActive = 0;
  return {
    requests,
    get peakActive() {
      return peakActive;
    },
    read() {
      const request = deferred();
      requests.push(request);
      active += 1;
      peakActive = Math.max(peakActive, active);
      return request.promise.finally(() => {
        active -= 1;
      });
    },
  };
}

test("a worker creation burst uses one immediate and one fresh trailing read", async () => {
  const host = controlledRead();
  const refresh = createRefreshCoordinator(() => host.read());
  const first = refresh();
  assert.equal(host.requests.length, 1, "idle refresh must start without a timer");

  const workers = Array.from({ length: 8 }, () => refresh());
  let workersReady = false;
  const allWorkers = Promise.all(workers).then((results) => {
    workersReady = true;
    return results;
  });
  assert.equal(host.requests.length, 1);

  host.requests[0].resolve("before worker creation");
  assert.equal(await first, "before worker creation");
  assert.equal(host.requests.length, 2);
  assert.equal(workersReady, false, "later callers cannot use the older snapshot");

  host.requests[1].resolve("all workers present");
  assert.deepEqual(await allWorkers, Array(8).fill("all workers present"));
  assert.equal(host.requests.length, 2);
  assert.equal(host.peakActive, 1);
});

test("mutations during the trailing read receive another fresh snapshot", async () => {
  const host = controlledRead();
  const refresh = createRefreshCoordinator(() => host.read());
  const first = refresh();
  const second = refresh();
  host.requests[0].resolve("first");
  await first;

  const third = refresh();
  const fourth = refresh();
  host.requests[1].resolve("second");
  assert.equal(await second, "second");
  assert.equal(host.requests.length, 3);
  host.requests[2].resolve("latest");
  assert.deepEqual(await Promise.all([third, fourth]), ["latest", "latest"]);
  assert.equal(host.peakActive, 1, "responses must commit in request order");
});

test("a failed read does not discard pending invalidations or prevent retry", async () => {
  const host = controlledRead();
  const refresh = createRefreshCoordinator(() => host.read());
  const first = refresh();
  const failed = assert.rejects(first, /host unavailable/);
  const trailing = refresh();
  host.requests[0].reject(new Error("host unavailable"));
  await failed;
  assert.equal(host.requests.length, 2);

  host.requests[1].resolve("recovered");
  assert.equal(await trailing, "recovered");
  const retry = refresh();
  assert.equal(host.requests.length, 3);
  host.requests[2].resolve("retried");
  assert.equal(await retry, "retried");
  assert.equal(host.peakActive, 1);
});

test("a synchronous read failure releases the coordinator for the next call", async () => {
  let attempts = 0;
  const refresh = createRefreshCoordinator(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("bridge unavailable");
    return Promise.resolve("ready");
  });
  await assert.rejects(refresh(), /bridge unavailable/);
  assert.equal(await refresh(), "ready");
});

function session(id, projectPath = null) {
  return {
    id,
    title: id,
    projectPath,
    mode: "agent",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    messageCount: 1,
  };
}

function sessionHarness(t, initialSessions) {
  const host = controlledRead();
  const commits = [];
  const restoredPaths = [];
  let state = {
    sessions: initialSessions,
    sessionMeta: {},
    activeSessionId: "parent",
    workspace: { path: "/parent-project" },
    page: "chat",
    restoreProjects: (paths) => restoredPaths.push(paths),
  };
  t.mock.method(api, "listSessions", () => host.read());
  const slice = createSessionSlice({
    get: () => state,
    set: (update) => {
      const patch = typeof update === "function" ? update(state) : update;
      commits.push(patch);
      state = { ...state, ...patch };
    },
    decorateSessions: (sessions, meta) =>
      sessions.map((entry) => ({
        ...entry,
        pinned: meta[entry.id]?.pinned === true,
      })),
  });
  return {
    host,
    commits,
    restoredPaths,
    refresh: slice.refreshSessions,
    get state() {
      return state;
    },
    updateState: (patch) => {
      state = { ...state, ...patch };
    },
  };
}

test("coalesced session refresh commits once and makes worker navigation ready", async (t) => {
  const parent = session("parent", "/parent-project");
  const worker = session("worker", "/worker-project");
  const harness = sessionHarness(t, [parent]);
  const first = harness.refresh();
  const pending = Array.from({ length: 8 }, () => harness.refresh());
  const navigation = pending[0].then(() => {
    const target = harness.state.sessions.find((entry) => entry.id === worker.id);
    assert.ok(target, "refresh must finish after the new session is committed");
    return target.id;
  });
  harness.host.requests[0].resolve({ sessions: [parent] });
  await first;
  assert.equal(harness.commits.length, 1);

  harness.updateState({
    activeSessionId: "another-session",
    workspace: { path: "/another-project" },
    page: "settings",
    sessionMeta: { worker: { pinned: true } },
  });
  harness.host.requests[1].resolve({ sessions: [parent, worker] });
  await Promise.all(pending);
  assert.equal(await navigation, worker.id);
  assert.equal(harness.host.requests.length, 2);
  assert.equal(harness.commits.length, 2, "waiters must not repeat the same set");
  assert.equal(harness.state.sessions[1].pinned, true);
  assert.equal(harness.state.activeSessionId, "another-session");
  assert.equal(harness.state.workspace.path, "/another-project");
  assert.equal(harness.state.page, "settings");
  assert.deepEqual(harness.restoredPaths, []);
});

test("an import waiting behind another refresh retains its original baseline", async (t) => {
  const existing = session("existing", "/already-known");
  const imported = session("imported", "/newly-imported");
  const unbound = session("unbound");
  const harness = sessionHarness(t, [existing]);
  const first = harness.refresh();
  const importedRefresh = harness.refresh({ revealImportedProjects: true });
  const ordinaryRefresh = harness.refresh();

  // The first response already sees the import. Capturing the baseline only
  // when the trailing read starts would now lose its archive restoration.
  harness.host.requests[0].resolve({ sessions: [existing, imported] });
  await first;
  assert.deepEqual(harness.restoredPaths, []);
  harness.host.requests[1].resolve({ sessions: [existing, imported, unbound] });
  await Promise.all([importedRefresh, ordinaryRefresh]);
  assert.deepEqual(harness.restoredPaths, [["/newly-imported"]]);
  assert.equal(harness.commits.length, 2);

  const repeated = harness.refresh({ revealImportedProjects: true });
  harness.host.requests[2].resolve({ sessions: [existing, imported, unbound] });
  await repeated;
  assert.deepEqual(harness.restoredPaths, [["/newly-imported"], []]);
});

test("failed imports leave session and archive state intact and can retry", async (t) => {
  const existing = session("existing", "/known");
  const imported = session("imported", "/imported");
  const harness = sessionHarness(t, [existing]);
  const failure = assert.rejects(
    harness.refresh({ revealImportedProjects: true }),
    /session list failed/,
  );
  harness.host.requests[0].reject(new Error("session list failed"));
  await failure;
  assert.deepEqual(harness.state.sessions, [existing]);
  assert.deepEqual(harness.commits, []);
  assert.deepEqual(harness.restoredPaths, []);

  const retry = harness.refresh({ revealImportedProjects: true });
  harness.host.requests[1].resolve({ sessions: [existing, imported] });
  await retry;
  assert.deepEqual(harness.restoredPaths, [["/imported"]]);
  assert.equal(harness.commits.length, 1);
});
