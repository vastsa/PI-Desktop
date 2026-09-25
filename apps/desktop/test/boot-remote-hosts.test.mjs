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
const { createRemoteHostTransportFactory } = await import(
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
  const requestListeners = new Set();
  const stateListeners = new Set();
  const reconnectListeners = new Set();
  const requests = [];
  return {
    requests,
    state: "disconnected",
    closeCalls: 0,
    async connect() {
      if (options.connect) return options.connect();
      if (options.connectRejects) throw options.connectRejects;
      this.state = "connected";
    },
    async close() {
      this.closeCalls += 1;
      this.state = "disconnected";
      listeners.clear();
    },
    push(envelope) {
      for (const listener of listeners) listener(envelope);
    },
    async serverRequest(method, params) {
      const handlers = [...requestListeners];
      if (handlers.length !== 1) throw new Error("no unique server request handler");
      return handlers[0](method, params);
    },
    client: {
      initialized: () => ({ principal: { roles: ["owner"] } }),
      hostCapabilities: () => options.hostCapabilities ?? {},
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
      onServerRequest(listener) {
        requestListeners.add(listener);
        return () => requestListeners.delete(listener);
      },
      onConnectionState(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      onReconnected(listener) {
        reconnectListeners.add(listener);
        return () => reconnectListeners.delete(listener);
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function manualRetryScheduler() {
  const timers = new Map();
  let nextId = 0;
  return {
    get pendingCount() {
      return timers.size;
    },
    delays() {
      return [...timers.values()].map(({ delayMs }) => delayMs);
    },
    schedule(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, delayMs });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    fireNext() {
      const entry = timers.entries().next().value;
      if (!entry) return Promise.resolve();
      const [id, timer] = entry;
      timers.delete(id);
      return Promise.resolve(timer.callback());
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

test("paired owner connection advertises and executes only the user MCP catalog", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({ hostKey: "owner-host", label: "Owner", url: "wss://owner", deviceToken: "device-token" });
  const calls = [];
  const adapters = [];
  const userMcp = {
    onCatalogChanged(listener) {
      this.listener = listener;
      return () => { this.listener = undefined; };
    },
    async toolsForRemoteSession() {
      return [{
        fullName: "mcp_global_lookup",
        serverId: "global",
        toolName: "lookup",
        description: "Search the user-configured service",
        schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }];
    },
    async callTool(fullName, args, projectPath, sessionId) {
      calls.push({ fullName, args, projectPath, sessionId });
      return { content: [{ type: "text", text: "found" }] };
    },
    cancelSessionCalls: (sessionId) => calls.push({ canceled: sessionId }),
  };
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption,
    router: createBackendRouter(),
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    userMcp,
    buildAdapter: () => {
      const adapter = fakeAdapter({ sessions: [makeSession("s1")], hostCapabilities: { toolRelay: true } });
      adapters.push(adapter);
      return adapter;
    },
  });
  assert.equal(await boot.open(), 1);
  const advertisement = adapters[0].requests.find(({ method }) => method === "tools/advertise");
  assert.deepEqual(advertisement.params.tools.map(({ name, workspaceFree }) => ({ name, workspaceFree })), [
    { name: "mcp_global_lookup", workspaceFree: true },
  ]);
  assert.equal(JSON.stringify(advertisement.params).includes("device-token"), false);
  const result = await adapters[0].serverRequest("tool/execute", {
    executionId: "exec-1",
    sessionId: "s1",
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: "mcp_global_lookup",
    args: { query: "notes" },
  });
  assert.deepEqual(result, { result: { content: [{ type: "text", text: "found" }] }, isError: false });
  assert.deepEqual(calls, [{
    fullName: "mcp_global_lookup",
    args: { query: "notes" },
    projectPath: null,
    sessionId: calls[0].sessionId,
  }]);
  assert.match(calls[0].sessionId, /owner-host.*s1/);
  await boot.closeAll();
  assert.equal(userMcp.listener, undefined);
  await cleanup();
});

test("remote transport factory resolves a fresh SSH forward on every retry", async () => {
  const urls = [];
  const builds = [];
  let tunnel = 0;
  const transportFactory = createRemoteHostTransportFactory(
    {
      hostKey: "ssh-host",
      label: "SSH host",
      url: "ws://127.0.0.1:1000/v1/racp/ws",
      deviceToken: "paired-token",
      metadata: {
        transport: "ssh",
        ssh: { host: "remote.test", remotePort: 43821, version: "1" },
      },
    },
    {
      open: async (hostKey, ssh, secret) => {
        assert.equal(hostKey, "ssh-host");
        assert.equal(ssh.host, "remote.test");
        assert.equal(secret, undefined);
        tunnel += 1;
        return { url: `ws://127.0.0.1:${1000 + tunnel}/v1/racp/ws`, localPort: 1000 + tunnel };
      },
    },
    ({ url, token }) => {
      builds.push({ url, token });
      urls.push(url);
      return async () => ({ send() {}, close() {}, onMessage() {}, onClose() {}, onError() {} });
    },
  );
  await transportFactory();
  await transportFactory();
  assert.deepEqual(urls, ["ws://127.0.0.1:1001/v1/racp/ws", "ws://127.0.0.1:1002/v1/racp/ws"]);
  assert.deepEqual(builds.map(({ token }) => token), ["paired-token", "paired-token"]);
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

test("a host that is offline at boot reconnects in the background when it returns", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({ hostKey: "offline", label: "Offline", url: "wss://offline", deviceToken: "t" });
  const scheduler = manualRetryScheduler();
  const router = createBackendRouter();
  const adapters = [];
  let available = false;
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption,
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    retryScheduler: scheduler,
    buildAdapter: () => {
      const adapter = fakeAdapter({
        sessions: [makeSession("s-offline")],
        connectRejects: available ? undefined : Object.assign(new Error("offline"), { code: "REMOTE_CONNECTION_FAILED" }),
      });
      adapters.push(adapter);
      return adapter;
    },
  });

  assert.equal(await boot.open(), 0);
  assert.equal(adapters.length, 1);
  assert.equal(scheduler.pendingCount, 1);
  assert.deepEqual(scheduler.delays(), [500]);
  assert.equal((await boot.list())[0].connected, false);

  available = true;
  await scheduler.fireNext();

  assert.equal(adapters.length, 2);
  assert.equal((await boot.list())[0].connected, true);
  assert.ok(router.backendForHost("offline"));
  assert.deepEqual(
    boot.listRemoteSessions().map(({ id }) => id),
    [makeRemoteSessionId("offline", "s-offline")],
  );
  assert.equal(scheduler.pendingCount, 0);
  await boot.closeAll();
  await cleanup();
});

for (const cleanupKind of ["removeHost", "closeAll"]) {
  test(`${cleanupKind} cancels a pending boot retry`, async () => {
    const { dir, cleanup } = await tmpDir();
    const encryption = reversibleEncryption();
    const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
    await registry.upsert({ hostKey: "offline", label: "Offline", url: "wss://offline", deviceToken: "t" });
    const scheduler = manualRetryScheduler();
    let attempts = 0;
    const boot = createRemoteHostsBoot({
      dataDir: dir,
      encryption,
      router: createBackendRouter(),
      emit: () => undefined,
      clientInfo: { name: "test", version: "0.15.0" },
      retryScheduler: scheduler,
      buildAdapter: () => {
        attempts += 1;
        return fakeAdapter({ connectRejects: new Error("offline") });
      },
    });

    assert.equal(await boot.open(), 0);
    assert.equal(scheduler.pendingCount, 1);
    if (cleanupKind === "removeHost") await boot.removeHost("offline");
    else await boot.closeAll();
    assert.equal(scheduler.pendingCount, 0);
    await scheduler.fireNext();
    assert.equal(attempts, 1);
    await boot.closeAll();
    await cleanup();
  });
}

for (const cleanupKind of ["removeHost", "closeAll"]) {
  test(`${cleanupKind} closes an in-flight adapter and rejects its late connect`, async () => {
    const { dir, cleanup } = await tmpDir();
    const encryption = reversibleEncryption();
    const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
    await registry.upsert({
      hostKey: "ssh-host",
      label: "SSH host",
      url: "ws://127.0.0.1:1000/v1/racp/ws",
      deviceToken: "t",
      metadata: {
        transport: "ssh",
        ssh: { host: "remote.test", remotePort: 43821, version: "1" },
      },
    });
    const scheduler = manualRetryScheduler();
    const retryConnectStarted = deferred();
    const lateConnect = deferred();
    const adapters = [];
    const tunnelCalls = { open: 0, close: 0, dispose: 0 };
    const tunnels = {
      async open() {
        tunnelCalls.open += 1;
        return { url: `ws://127.0.0.1:${1000 + tunnelCalls.open}/v1/racp/ws`, localPort: 1000 + tunnelCalls.open };
      },
      async close() {
        tunnelCalls.close += 1;
      },
      async dispose() {
        tunnelCalls.dispose += 1;
      },
      async adopt() {
        throw new Error("not used in this test");
      },
    };
    const events = [];
    const router = createBackendRouter();
    const boot = createRemoteHostsBoot({
      dataDir: dir,
      encryption,
      router,
      emit: (channel, payload) => events.push({ channel, payload }),
      clientInfo: { name: "test", version: "0.15.0" },
      retryScheduler: scheduler,
      tunnels,
      buildAdapter: () => {
        const adapter = adapters.length === 0
          ? fakeAdapter({ connectRejects: new Error("offline") })
          : fakeAdapter({
              connect: async () => {
                retryConnectStarted.resolve();
                await lateConnect.promise;
              },
            });
        adapters.push(adapter);
        return adapter;
      },
    });

    assert.equal(await boot.open(), 0);
    assert.equal(scheduler.pendingCount, 1);
    const retryRun = scheduler.fireNext();
    await retryConnectStarted.promise;
    assert.equal(adapters.length, 2);

    if (cleanupKind === "removeHost") await boot.removeHost("ssh-host");
    else await boot.closeAll();
    assert.ok(adapters[1].closeCalls >= 1);
    assert.equal(scheduler.pendingCount, 0);

    lateConnect.resolve();
    await retryRun;
    assert.equal(router.backendForHost("ssh-host"), null);
    assert.deepEqual(boot.listRemoteSessions(), []);
    assert.equal(adapters[1].state, "disconnected");
    assert.ok(tunnelCalls.close + tunnelCalls.dispose > 0);
    assert.equal(
      events.some(({ payload }) => payload?.reason === "remote.hosts.opened"),
      false,
    );
    await boot.closeAll();
    await cleanup();
  });
}

test("a tunnel that opens after removeHost is closed without creating an adapter", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({
    hostKey: "ssh-host",
    label: "SSH host",
    url: "ws://127.0.0.1:1000/v1/racp/ws",
    deviceToken: "t",
    metadata: {
      transport: "ssh",
      ssh: { host: "remote.test", remotePort: 43821, version: "1" },
    },
  });
  const openStarted = deferred();
  const lateTunnel = deferred();
  let closeCalls = 0;
  let adapterBuilds = 0;
  const router = createBackendRouter();
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption,
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    tunnels: {
      open() {
        openStarted.resolve();
        return lateTunnel.promise;
      },
      async close() {
        closeCalls += 1;
      },
      async dispose() {},
      async adopt() {
        throw new Error("not used in this test");
      },
    },
    buildAdapter: () => {
      adapterBuilds += 1;
      return fakeAdapter();
    },
  });

  const opening = boot.open();
  await openStarted.promise;
  await boot.removeHost("ssh-host");
  lateTunnel.resolve({ url: "ws://127.0.0.1:1001/v1/racp/ws", localPort: 1001 });
  assert.equal(await opening, 0);

  assert.equal(adapterBuilds, 0);
  assert.ok(closeCalls >= 2, "remove and stale-open cleanup both close the forward");
  assert.equal(router.backendForHost("ssh-host"), null);
  await boot.closeAll();
  await cleanup();
});

test("a late old connect cannot retire a re-paired host generation", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({ hostKey: "hostA", label: "Old", url: "wss://old", deviceToken: "old-token" });
  const scheduler = manualRetryScheduler();
  const retryConnectStarted = deferred();
  const lateConnect = deferred();
  const adapters = [];
  const router = createBackendRouter();
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption,
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    retryScheduler: scheduler,
    buildAdapter: (record) => {
      const adapter = adapters.length === 0
        ? fakeAdapter({ connectRejects: new Error("offline") })
        : adapters.length === 1
          ? fakeAdapter({
              connect: async () => {
                retryConnectStarted.resolve();
                await lateConnect.promise;
              },
            })
          : fakeAdapter({ sessions: [makeSession("new-session")] });
      adapters.push(adapter);
      assert.equal(record.deviceToken, adapters.length === 3 ? "new-token" : "old-token");
      return adapter;
    },
  });

  assert.equal(await boot.open(), 0);
  const oldRetry = scheduler.fireNext();
  await retryConnectStarted.promise;
  const paired = await boot.addHost({
    hostKey: "hostA",
    label: "New",
    url: "wss://new",
    deviceToken: "new-token",
  });
  assert.equal(paired.connected, true);
  assert.equal(scheduler.pendingCount, 0);
  assert.ok(router.backendForHost("hostA"));

  lateConnect.resolve();
  await oldRetry;
  assert.ok(router.backendForHost("hostA"));
  assert.deepEqual(
    boot.listRemoteSessions().map(({ id }) => id),
    [makeRemoteSessionId("hostA", "new-session")],
  );
  assert.ok(adapters[1].closeCalls >= 1);
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
