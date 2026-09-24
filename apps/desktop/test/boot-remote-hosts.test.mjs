import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteSessionId } = await import(
  "../electron/main/remote/backend-router.ts"
);
const { createRemoteHostsBoot } = await import(
  "../electron/main/bootstrap/remote-hosts.ts"
);
const { createRemoteHostRegistry } = await import(
  "../electron/main/remote/remote-host-registry.ts"
);

function reversibleEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buf) => {
      const text = buf.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
      return text.slice("enc:".length);
    },
  };
}

async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), "boot-remote-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A stand-in for the RacpClient-backed adapter. Records the calls so tests
 * can assert on them, and lets the test push RACP envelopes back. */
function fakeAdapter(options = {}) {
  const listeners = new Set();
  const requests = [];
  return {
    requests,
    state: "disconnected",
    async connect() {
      if (options.connectRejects) throw options.connectRejects;
      this.state = "connected";
    },
    async close() {
      this.state = "disconnected";
      listeners.clear();
    },
    push(envelope) {
      for (const listener of listeners) listener(envelope);
    },
    client: {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "session/list") {
          return { sessions: options.sessions ?? [] };
        }
        if (options.responses?.[method]) return options.responses[method](params);
        return { ok: true };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

function makeSession(id) {
  return {
    id,
    title: id,
    mode: "chat",
    status: "idle",
    planningState: "inactive",
    permissionMode: "default",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
  };
}

test("open on an empty registry is a no-op: nothing registers, closeAll clean", async () => {
  const { dir, cleanup } = await tmpDir();
  const router = createBackendRouter();
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
  });
  const events = [];
  const boot2 = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router,
    emit: (channel, payload) => events.push({ channel, payload }),
    clientInfo: { name: "test", version: "0.15.0" },
  });
  assert.equal(await boot.open(), 0);
  assert.equal(await boot2.open(), 0);
  assert.equal(router.backendForHost("h"), null);
  assert.deepEqual(boot.listRemoteSessions(), []);
  // Nothing opened, so the sidebar is not asked to refresh.
  assert.equal(events.length, 0);
  await boot2.closeAll();
  await boot.closeAll();
  await cleanup();
});

test("open connects each paired host, registers each host, and lists their sessions", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({
    hostKey: "hostA",
    label: "A",
    url: "wss://a",
    deviceToken: "t-a",
  });
  await registry.upsert({
    hostKey: "hostB",
    label: "B",
    url: "wss://b",
    deviceToken: "t-b",
  });

  const adaptersByHost = new Map();
  const router = createBackendRouter();
  const events = [];
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption,
    router,
    emit: (channel, payload) => events.push({ channel, payload }),
    clientInfo: { name: "test", version: "0.15.0" },
    buildAdapter: (record) => {
      const adapter = fakeAdapter({
        sessions: [makeSession(`s-${record.hostKey}`)],
      });
      adaptersByHost.set(record.hostKey, adapter);
      return adapter;
    },
  });

  const opened = await boot.open();
  assert.equal(opened, 2);
  assert.ok(router.backendForHost("hostA"));
  assert.ok(router.backendForHost("hostB"));
  const listed = boot.listRemoteSessions();
  assert.deepEqual(
    listed.map((s) => s.id).sort(),
    [makeRemoteSessionId("hostA", "s-hostA"), makeRemoteSessionId("hostB", "s-hostB")],
  );
  assert.equal(listed.find((s) => s.id.includes("hostA")).remote.hostLabel, "A");
  assert.equal(
    events.filter((event) => event.channel === IPC.event.sessionsChanged).length,
    1,
    "open emits one sessionsChanged once a host is online",
  );

  await boot.closeAll();
  assert.equal(router.backendForHost("hostA"), null);
  assert.deepEqual(boot.listRemoteSessions(), []);
  for (const adapter of adaptersByHost.values()) {
    assert.equal(adapter.state, "disconnected");
  }
  await cleanup();
});

test("a host whose connect fails is logged and skipped without killing the others", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({ hostKey: "bad", label: "Bad", url: "wss://bad", deviceToken: "t" });
  await registry.upsert({ hostKey: "good", label: "Good", url: "wss://good", deviceToken: "t" });
  const router = createBackendRouter();
  const warnings = [];
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption,
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    log: (level, message) => {
      if (level === "warn") warnings.push(message);
    },
    buildAdapter: (record) =>
      record.hostKey === "bad"
        ? fakeAdapter({ connectRejects: Object.assign(new Error("no route"), { code: "REMOTE_CONNECTION_FAILED" }) })
        : fakeAdapter({ sessions: [makeSession(`s-${record.hostKey}`)] }),
  });
  const opened = await boot.open();
  assert.equal(opened, 1);
  assert.ok(warnings.some((message) => /bad failed to open/.test(message)));
  assert.ok(router.backendForHost("good"));
  // The failed host fails closed: its sessions are refused, never run locally.
  assert.equal(router.backendForHost("bad"), null);
  await assert.rejects(
    router.route(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId("bad", "s") }]),
    (error) => error.errorCode === "HOST_UNAVAILABLE",
  );
  await boot.closeAll();
  await cleanup();
});

test("closeAll is idempotent and safe to call before open", async () => {
  const { dir, cleanup } = await tmpDir();
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router: createBackendRouter(),
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
  });
  await boot.closeAll();
  await boot.closeAll();
  await cleanup();
});

async function bootOneHost({ responses = {}, sessions = [] } = {}) {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({ hostKey: "hostA", label: "A", url: "wss://a", deviceToken: "t" });
  const events = [];
  let adapter;
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption,
    router: createBackendRouter(),
    emit: (channel, payload) => events.push({ channel, payload }),
    clientInfo: { name: "test", version: "0.15.0" },
    buildAdapter: () => (adapter = fakeAdapter({ sessions, responses })),
  });
  await boot.open();
  return { boot, events, adapter: () => adapter, cleanup };
}

test("project and session requests on a host that is not connected fail with HOST_UNAVAILABLE", async () => {
  const { boot, cleanup } = await bootOneHost();
  const unavailable = (error) =>
    error.errorCode === "HOST_UNAVAILABLE" && error.data.retriable === true;
  await assert.rejects(async () => boot.listProjects("nope"), unavailable);
  await assert.rejects(async () => boot.browseProject("nope"), unavailable);
  await assert.rejects(async () => boot.registerProject("nope", "/x"), unavailable);
  await assert.rejects(async () => boot.createSession("nope", "p1"), unavailable);
  await boot.closeAll();
  await assert.rejects(async () => boot.listProjects("hostA"), unavailable);
  await cleanup();
});

test("listProjects / browseProject / registerProject forward to the host and trim the shape", async () => {
  const { boot, adapter, cleanup } = await bootOneHost({
    responses: {
      "project/list": () => ({
        projects: [{ id: "p1", label: "repo", archived: false, path: "/srv/secret/repo" }],
      }),
      "project/browse": () => ({ path: "/srv", entries: [] }),
      "project/register": () => ({
        project: { id: "p2", label: "new", archived: false, path: "/srv/new" },
      }),
    },
  });
  assert.deepEqual(await boot.listProjects("hostA"), [{ id: "p1", label: "repo", archived: false }]);
  assert.deepEqual(await boot.browseProject("hostA"), { path: "/srv", entries: [] });
  await boot.browseProject("hostA", "/srv/sub");
  assert.deepEqual(await boot.registerProject("hostA", "/srv/new"), {
    id: "p2",
    label: "new",
    archived: false,
  });
  const sent = adapter()
    .requests.filter((r) => r.method.startsWith("project/"))
    .map((r) => [r.method, r.params]);
  assert.deepEqual(sent, [
    ["project/list", undefined],
    ["project/browse", {}],
    ["project/browse", { path: "/srv/sub" }],
    ["project/register", { path: "/srv/new" }],
  ]);
  await boot.closeAll();
  await cleanup();
});

test("createSession creates on the host, caches the session, and emits sessionsChanged", async () => {
  const created = { ...makeSession("s-new"), updatedAt: "2026-09-20T10:00:00.000Z" };
  const { boot, events, adapter, cleanup } = await bootOneHost({
    sessions: [makeSession("s-old")],
    responses: { "session/create": () => ({ session: created }) },
  });
  events.length = 0;
  const summary = await boot.createSession("hostA", "p1", "Title");
  assert.equal(summary.id, makeRemoteSessionId("hostA", "s-new"));
  assert.equal(summary.source, "remote");
  assert.deepEqual(
    adapter().requests.find((r) => r.method === "session/create").params,
    { projectId: "p1", title: "Title" },
  );
  assert.equal(boot.listRemoteSessions()[0].id, summary.id);
  assert.deepEqual(events.map((e) => e.channel), [IPC.event.sessionsChanged]);
  // No selectSessionId: the renderer selects the returned summary itself.
  assert.equal(events[0].payload.selectSessionId, undefined);

  await boot.createSession("hostA", "p1");
  assert.deepEqual(
    adapter().requests.filter((r) => r.method === "session/create").at(-1).params,
    { projectId: "p1" },
  );
  await boot.closeAll();
  await cleanup();
});
