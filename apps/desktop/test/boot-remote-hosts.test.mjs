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
  let state = "disconnected";
  return {
    requests,
    state: () => state,
    async connect() {
      if (options.connectRejects) throw options.connectRejects;
      state = "connected";
    },
    async close() {
      state = "disconnected";
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
        if (method === "events/subscribe") return { subscriptionId: `sub-${params.sessionId ?? "host"}`, starting: { epoch: "e1", sequence: 1 }, replayComplete: true };
        if (method === "session/attach") {
          const session = options.sessions.find((row) => row.id === params.sessionId);
          return { session, snapshot: { session, items: [], activeItems: [], pendingApprovals: [], pendingInputs: [], queuedTurns: [], hasMoreHistory: false, cursor: { epoch: "e1", sequence: 0 }, revision: 1, generatedAt: session.updatedAt } };
        }
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
  assert.equal(await boot.open(), 0);
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: "remote:h:s" }]), null);
  await boot.closeAll();
  await cleanup();
});

test("open connects each paired host and registers a backend per listed session", async () => {
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
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [
      { id: makeRemoteSessionId("hostA", "s-hostA") },
    ]),
  );
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [
      { id: makeRemoteSessionId("hostB", "s-hostB") },
    ]),
  );

  await boot.closeAll();
  for (const adapter of adaptersByHost.values()) {
    assert.equal(adapter.state(), "disconnected");
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
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [
      { id: makeRemoteSessionId("good", "s-good") },
    ]),
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

test("closeAll cancels an opening adapter before awaiting open and owns cleanup once", async () => {
  const { dir, cleanup } = await tmpDir();
  const connecting = Promise.withResolvers();
  const started = Promise.withResolvers();
  const adapter = fakeAdapter({ sessions: [makeSession("late")] });
  let closes = 0;
  let disposals = 0;
  adapter.connect = () => { started.resolve(); return connecting.promise; };
  adapter.close = async () => { closes++; connecting.reject(new Error("connect canceled")); };
  const router = createBackendRouter();
  const boot = createRemoteHostsBoot({
    dataDir: dir, encryption: reversibleEncryption(), router, emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" }, buildAdapter: () => adapter,
    tunnels: { close: async () => undefined, dispose: async () => { disposals++; } },
  });
  await boot.registry.upsert({ hostKey: "pending", label: "Pending", url: "wss://pending", deviceToken: "t" });
  const opening = boot.open().then(value => ({ value }), error => ({ error }));
  await started.promise;
  const closing = boot.closeAll();
  const again = boot.closeAll();
  const canceledAtShutdown = closes;
  // Release the fixture even on the old code, so the regression fails rather than hangs.
  connecting.resolve();
  const result = await opening;
  await Promise.all([closing, again]);
  await cleanup();
  assert.equal(canceledAtShutdown, 1, "shutdown must close a connecting adapter immediately");
  assert.ok(result.error, "an interrupted open must reject rather than report success");
  assert.equal(closes, 1, "open failure and closeAll share the same cleanup");
  assert.equal(disposals, 1, "concurrent closeAll calls share shutdown");
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId("pending", "late") }]), null);
});

test("closeAll disposes a pending SSH forward before draining host operations", async () => {
  const { createSshTunnelManager } = await import("../electron/main/remote/ssh-tunnel.ts");
  const { dir, cleanup } = await tmpDir();
  const forwarding = Promise.withResolvers();
  const started = Promise.withResolvers();
  let disposed = 0;
  let forwardCloses = 0;
  let adapters = 0;
  const tunnels = createSshTunnelManager({
    reservePort: async () => 1234,
    buildTransport: () => ({ forward: () => { started.resolve(); return forwarding.promise; }, dispose: () => { disposed++; } }),
  });
  const boot = createRemoteHostsBoot({
    dataDir: dir, encryption: reversibleEncryption(), router: createBackendRouter(), emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" }, tunnels,
    buildAdapter: () => { adapters++; return fakeAdapter(); },
  });
  const opening = boot.addHost({ hostKey: "pending-ssh", label: "SSH", url: "ws://127.0.0.1:1234/v1/racp/ws", deviceToken: "t",
    metadata: { transport: "ssh", ssh: { host: "remote.example", remotePort: 1234, version: "0.15.0" } },
  }).then(value => ({ value }), error => ({ error }));
  await started.promise;
  const closing = boot.closeAll();
  const disposedAtShutdown = disposed;
  forwarding.resolve({ localPort: 1234, close: async () => { forwardCloses++; } });
  const result = await opening;
  await closing;
  await cleanup();
  assert.equal(disposedAtShutdown, 1, "pending SSH creation must be canceled before waiting on openHost");
  assert.ok(result.error);
  assert.equal(adapters, 0, "a late tunnel must not create an adapter after shutdown");
  assert.equal(forwardCloses, 1);
  assert.equal(disposed, 1);
});

test("closeAll closes the adapter without waiting for subscription cleanup to finish", async () => {
  const { dir, cleanup } = await tmpDir();
  const listing = Promise.withResolvers();
  const listed = Promise.withResolvers();
  const unsubscribing = Promise.withResolvers();
  const adapter = fakeAdapter();
  const request = adapter.client.request;
  adapter.client.request = (method, params) => {
    if (method === "session/list") { listed.resolve(); return listing.promise; }
    if (method === "events/unsubscribe") return unsubscribing.promise;
    return request(method, params);
  };
  let closes = 0;
  adapter.close = async () => { closes++; listing.reject(new Error("connection closed")); unsubscribing.resolve({ ok: true }); };
  const router = createBackendRouter();
  const boot = createRemoteHostsBoot({ dataDir: dir, encryption: reversibleEncryption(), router, emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" }, buildAdapter: () => adapter });
  const opening = boot.addHost({ hostKey: "h", label: "Host", url: "wss://host", deviceToken: "t" }).catch(error => error);
  await listed.promise;
  const closing = boot.closeAll();
  const canceledAtShutdown = closes;
  listing.resolve({ sessions: [] });
  unsubscribing.resolve({ ok: true });
  await opening;
  await closing;
  await cleanup();
  assert.equal(canceledAtShutdown, 1);
  assert.equal(closes, 1);
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId("h", "late") }]), null);
});

test("bootstrapHost closes its unadopted outcome when shutdown rejects its queued action", async () => {
  const { dir, cleanup } = await tmpDir();
  const connecting = Promise.withResolvers();
  const started = Promise.withResolvers();
  const completed = Promise.withResolvers();
  const adapter = fakeAdapter();
  adapter.connect = () => { started.resolve(); return connecting.promise; };
  adapter.close = async () => { connecting.reject(new Error("connection closed")); };
  let forwardCloses = 0;
  let adoptions = 0;
  const version = "0.15.0";
  const forward = { localPort: 1234, close: async () => { forwardCloses++; } };
  const boot = createRemoteHostsBoot({
    dataDir: dir, encryption: reversibleEncryption(), router: createBackendRouter(), emit: () => undefined,
    clientInfo: { name: "test", version }, buildAdapter: () => adapter,
    log: (_level, message) => { if (message === "ssh bootstrap completed") completed.resolve(); },
    tunnels: { close: async () => undefined, dispose: async () => undefined, adopt: async () => { adoptions++; } },
    sshBootstrap: {
      buildTransport: () => ({
        exec: async () => ({ code: 0, stdout: "Linux\nx86_64\n", stderr: "" }),
        execWithInput: async () => ({ code: 0, stderr: "", stdout: `PI_HOST_READY ${JSON.stringify({ hostId: "host", host: "127.0.0.1", port: 1234, version })}\nPI_HOST_PAIRING_TOKEN ${JSON.stringify({ token: "fixture-token", expiresAt: 1893456000000 })}` }),
        forward: async () => forward, dispose: () => undefined,
      }),
      fetchChecksum: async () => `${"a".repeat(64)}  pi-host-${version}-linux-x64.tar.gz`,
      reservePort: async () => 1234, exchangePairing: async () => "fixture-device-token",
    },
  });
  const previous = boot.addHost({ hostKey: "ssh-remote.example-box", label: "Box", url: "wss://host", deviceToken: "t" }).catch(error => error);
  await started.promise;
  const pairing = boot.bootstrapHost({ host: "remote.example", label: "Box" }).then(value => ({ value }), error => ({ error }));
  await completed.promise;
  // Let the completed bootstrap hand its outcome to the per-host serial queue.
  await Promise.resolve();
  const closing = boot.closeAll();
  connecting.resolve();
  await previous;
  const result = await pairing;
  await closing;
  await cleanup();
  assert.ok(result.error);
  assert.equal(adoptions, 0);
  assert.equal(forwardCloses, 1, "a queued action rejected before entry still owns its bootstrap outcome");
});
