import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  ROUTE_LOCAL,
  createBackendRouter,
  makeRemoteSessionId,
  parseRemoteSessionId,
  isRemoteSessionId,
  sessionIdForCall,
} = await import("../electron/main/remote/backend-router.ts");

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

test("routes locally until a backend is registered for the session", async () => {
  const router = createBackendRouter();
  const remote = makeRemoteSessionId("h", "s");
  assert.equal(await router.route("session.get", [{ sessionId: remote }]), ROUTE_LOCAL);

  const calls = [];
  router.registerBackend(remote, {
    handles: (channel) => channel === "session.get",
    invoke: async (channel, args) => {
      calls.push([channel, args]);
      return { id: remote, source: "remote" };
    },
  });

  const outcome = await router.route("session.get", [{ sessionId: remote }]);
  assert.notEqual(outcome, ROUTE_LOCAL);
  assert.deepEqual(outcome, { remote: true, value: { id: remote, source: "remote" } });
  assert.equal(calls.length, 1);

  // A channel the backend does not cover falls back to local.
  assert.equal(await router.route("settings.get", [{ sessionId: remote }]), ROUTE_LOCAL);
  // A local session id is never routed even after a remote backend exists.
  assert.equal(await router.route("session.get", [{ sessionId: "local" }]), ROUTE_LOCAL);

  router.unregisterBackend(remote);
  assert.equal(await router.route("session.get", [{ sessionId: remote }]), ROUTE_LOCAL);
});

test("route surfaces a backend failure to the caller", async () => {
  const router = createBackendRouter();
  const remote = makeRemoteSessionId("h", "s");
  router.registerBackend(remote, {
    handles: () => true,
    invoke: async () => {
      throw Object.assign(new Error("host gone"), { errorCode: "HOST_DISCONNECTED" });
    },
  });
  await assert.rejects(() => router.route("session.get", [remote]), /host gone/);
});
