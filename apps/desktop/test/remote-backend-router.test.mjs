import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const {
  LOCAL_SAFE_CHANNELS,
  ROUTE_LOCAL,
  assertNotRemoteCall,
  makeRemoteQueuedTurnId,
  normalizeRemoteError,
  parseRemoteQueuedTurnId,
  createBackendRouter,
  makeRemoteSessionId,
  parseRemoteSessionId,
  isRemoteSessionId,
  sessionIdForCall,
} = await import("../electron/main/remote/backend-router.ts");
const { HANDLED_CHANNELS, createRemoteBackend } = await import(
  "../electron/main/remote/remote-backend.ts"
);

test("namespaces and parses remote session ids", () => {
  const id = makeRemoteSessionId("hostA", "sess_1");
  assert.equal(id, "remote:hostA:sess_1");
  assert.ok(isRemoteSessionId(id));
  assert.ok(!isRemoteSessionId("sess_1"));
  assert.ok(!isRemoteSessionId("native-pi:codex:abc"));
  assert.deepEqual(parseRemoteSessionId(id), { hostKey: "hostA", hostSessionId: "sess_1" });
  // A host session id may itself contain ':'; only the first separator splits.
  assert.deepEqual(parseRemoteSessionId("remote:hostA:a:b"), {
    hostKey: "hostA",
    hostSessionId: "a:b",
  });
  assert.equal(parseRemoteSessionId("remote:onlyhost"), null);
  assert.equal(parseRemoteSessionId("desktop-session"), null);
});

test("rejects a hostKey containing the separator", () => {
  assert.throws(() => makeRemoteSessionId("host:bad", "s"), /hostKey must not contain/);
});

test("sessionIdForCall reads positional and object session ids", () => {
  const remote = makeRemoteSessionId("h", "s");
  assert.equal(sessionIdForCall([remote]), remote);
  assert.equal(sessionIdForCall([{ sessionId: remote }]), remote);
  assert.equal(sessionIdForCall(["local-session"]), null);
  assert.equal(sessionIdForCall([{ sessionId: "local-session" }]), null);
  assert.equal(sessionIdForCall([]), null);
  assert.equal(sessionIdForCall([42]), null);
});

function recordingBackend(handles = () => true, invoke = async () => "served") {
  const calls = [];
  return {
    calls,
    handles,
    invoke: async (channel, args) => {
      calls.push([channel, args]);
      return invoke(channel, args);
    },
  };
}

test("sessionIdForCall reads bare ids, encoded approval ids, and encoded queued-turn ids", () => {
  const remote = makeRemoteSessionId("h", "s");
  assert.equal(sessionIdForCall([{ id: remote }]), remote);
  assert.equal(sessionIdForCall([{ turnId: makeRemoteQueuedTurnId(remote, "t1") }]), remote);
  assert.equal(sessionIdForCall([{ turnId: "local-turn" }]), null);
});

test("a call naming no remote session always routes locally", async () => {
  const router = createBackendRouter();
  assert.equal(await router.route(IPC.invoke.sessionGet, [{ id: "local" }]), ROUTE_LOCAL);
  assert.equal(await router.route(IPC.invoke.sessionGet, []), ROUTE_LOCAL);
});

test("a remote call with no registered host fails closed with retriable HOST_UNAVAILABLE", async () => {
  const router = createBackendRouter();
  const remote = makeRemoteSessionId("h", "s");
  await assert.rejects(
    router.route(IPC.invoke.sessionGet, [{ id: remote }]),
    (error) => error.errorCode === "HOST_UNAVAILABLE" && error.data.retriable === true,
  );
  // Another host's backend does not serve this host's sessions.
  router.registerHost("other", recordingBackend());
  await assert.rejects(
    router.route(IPC.invoke.sessionGet, [{ id: remote }]),
    (error) => error.errorCode === "HOST_UNAVAILABLE",
  );
});

test("every IPC invoke channel with a remote id is served remotely, audited local, or refused", async () => {
  const router = createBackendRouter();
  const hostKey = "hostA";
  const remote = makeRemoteSessionId(hostKey, "s1");
  const backend = recordingBackend((channel) => HANDLED_CHANNELS.has(channel));
  router.registerHost(hostKey, backend);

  // The two sets are disjoint: an audited local channel is never also remote.
  for (const channel of LOCAL_SAFE_CHANNELS) assert.equal(HANDLED_CHANNELS.has(channel), false, channel);
  // The real backend's handles() is exactly HANDLED_CHANNELS.
  const real = createRemoteBackend({ hostKey, hostLabel: "A", client: { request: async () => ({}) } });

  const channels = [...new Set(Object.values(IPC.invoke))];
  assert.ok(channels.length > 50, "IPC.invoke enumeration looks empty");
  for (const channel of channels) {
    assert.equal(real.handles(channel), HANDLED_CHANNELS.has(channel), channel);
    for (const args of [[remote], [{ sessionId: remote }], [{ id: remote }]]) {
      const before = backend.calls.length;
      let outcome;
      let error;
      try {
        outcome = await router.route(channel, args);
      } catch (caught) {
        error = caught;
      }
      if (HANDLED_CHANNELS.has(channel)) {
        assert.equal(error, undefined, channel);
        assert.deepEqual(outcome, { remote: true, value: "served" }, channel);
        assert.equal(backend.calls.length, before + 1, channel);
      } else if (LOCAL_SAFE_CHANNELS.has(channel)) {
        assert.equal(outcome, ROUTE_LOCAL, channel);
        assert.equal(backend.calls.length, before, channel);
      } else {
        assert.ok(error, `${channel} must fail closed, got ${String(outcome)}`);
        assert.equal(error.errorCode, "CAPABILITY_UNAVAILABLE", channel);
        assert.equal(error.data.retriable, false, channel);
        assert.equal(backend.calls.length, before, channel);
      }
    }
  }
});

test("unregisterHost with a backend only releases that exact registration", async () => {
  const router = createBackendRouter();
  const first = recordingBackend();
  const second = recordingBackend();
  router.registerHost("h", first);
  router.registerHost("h", second);
  // A closing stale connection must not drop its replacement.
  router.unregisterHost("h", first);
  assert.equal(router.backendForHost("h"), second);
  router.unregisterHost("h", second);
  assert.equal(router.backendForHost("h"), null);
  router.registerHost("h", first);
  router.unregisterHost("h");
  assert.equal(router.backendForHost("h"), null);
  await assert.rejects(
    router.route(IPC.invoke.sessionGet, [makeRemoteSessionId("h", "s")]),
    (error) => error.errorCode === "HOST_UNAVAILABLE",
  );
});

test("route surfaces a backend failure to the caller", async () => {
  const router = createBackendRouter();
  const remote = makeRemoteSessionId("h", "s");
  router.registerHost(
    "h",
    recordingBackend(
      () => true,
      async () => {
        throw Object.assign(new Error("host gone"), { errorCode: "HOST_DISCONNECTED" });
      },
    ),
  );
  await assert.rejects(
    () => router.route(IPC.invoke.sessionGet, [remote]),
    (error) => /host gone/.test(error.message) && error.errorCode === "HOST_DISCONNECTED",
  );
});

test("route normalizes a RACP client error into the IPC error shape", async () => {
  const router = createBackendRouter();
  router.registerHost(
    "h",
    recordingBackend(
      () => true,
      async () => {
        throw Object.assign(new Error("busy"), { code: "SESSION_BUSY", retriable: true });
      },
    ),
  );
  await assert.rejects(
    router.route(IPC.invoke.agentPrompt, [{ sessionId: makeRemoteSessionId("h", "s") }]),
    (error) =>
      error.errorCode === "SESSION_BUSY" &&
      error.data.errorCode === "SESSION_BUSY" &&
      error.data.retriable === true &&
      error.message === "busy",
  );
});

test("normalizeRemoteError maps RACP {code,retriable} and leaves everything else alone", () => {
  const racp = Object.assign(new Error("nope"), { code: "NOT_FOUND", retriable: false });
  const normalized = normalizeRemoteError(racp);
  assert.equal(normalized.errorCode, "NOT_FOUND");
  assert.deepEqual(normalized.data, { errorCode: "NOT_FOUND", retriable: false });
  assert.equal(normalized.message, "nope");

  const already = Object.assign(new Error("x"), { errorCode: "INTERNAL", code: "Y", retriable: true });
  assert.equal(normalizeRemoteError(already), already);
  const nodeError = Object.assign(new Error("fs"), { code: "ENOENT" });
  assert.equal(normalizeRemoteError(nodeError), nodeError);
  assert.equal(normalizeRemoteError("plain"), "plain");
  const obj = { code: "X", retriable: true };
  assert.equal(normalizeRemoteError(obj), obj);
});

test("queued-turn ids round-trip and reject plain or malformed ids", () => {
  const remote = makeRemoteSessionId("h", "s:1");
  const encoded = makeRemoteQueuedTurnId(remote, "turn-9");
  assert.deepEqual(parseRemoteQueuedTurnId(encoded), { remoteSessionId: remote, hostTurnId: "turn-9" });
  assert.equal(parseRemoteQueuedTurnId("turn-9"), null);
  assert.equal(parseRemoteQueuedTurnId(`${remote}#racp-turn:`), null);
  assert.equal(parseRemoteQueuedTurnId("local#racp-turn:t"), null);
  assert.equal(parseRemoteQueuedTurnId("#racp-turn:t"), null);
});

test("assertNotRemoteCall refuses remote ids and lets local calls through", () => {
  const remote = makeRemoteSessionId("h", "s");
  assert.doesNotThrow(() => assertNotRemoteCall([{ sessionId: "local" }]));
  assert.doesNotThrow(() => assertNotRemoteCall([]));
  for (const args of [
    [remote],
    [{ sessionId: remote }],
    [{ id: remote }],
    [{ turnId: makeRemoteQueuedTurnId(remote, "t") }],
  ]) {
    assert.throws(
      () => assertNotRemoteCall(args),
      (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
    );
  }
});
