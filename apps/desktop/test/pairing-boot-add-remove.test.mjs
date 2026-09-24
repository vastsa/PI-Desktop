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

/** Fake encryption round-trips through a well-known prefix so a test can
 * distinguish plaintext leaks (rejected) from encrypted round-trips (accepted). */
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
  const dir = await mkdtemp(join(tmpdir(), "pairing-ux-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function fakeSession(id) {
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

/** A fake adapter mirroring `RacpRemoteHostClient` — enough surface for the
 * boot layer to build one host from a record. Tracks connection state so a
 * test can assert on `closeHost`. */
function fakeAdapter({ sessions = [], failConnect } = {}) {
  const listeners = new Set();
  return {
    state: "disconnected",
    async connect() {
      if (failConnect) throw failConnect;
      this.state = "connected";
    },
    async close() {
      this.state = "disconnected";
      listeners.clear();
    },
    client: {
      request: async (method) =>
        method === "session/list" ? { sessions } : { ok: true },
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
}

test("addHost persists, opens, and reports connected=true when the adapter succeeds", async () => {
  const { dir, cleanup } = await tmpDir();
  const router = createBackendRouter();
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    buildAdapter: () => fakeAdapter({ sessions: [fakeSession("s1")] }),
  });
  const summary = await boot.addHost({
    hostKey: "hostA",
    label: "Home",
    url: "wss://home.local:9443/racp",
    deviceToken: "rd_secret",
  });
  assert.equal(summary.connected, true);
  assert.equal(summary.hostKey, "hostA");
  // The router now serves every remote session id under this hostKey.
  assert.ok(router.backendForHost("hostA"), "router must have a backend after addHost");
  const listed = await boot.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].connected, true);
  assert.ok(!("deviceToken" in listed[0]), "list must never expose the device token");
  await boot.closeAll();
  await cleanup();
});

test("addHost still persists when the connection fails to open", async () => {
  const { dir, cleanup } = await tmpDir();
  const router = createBackendRouter();
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    buildAdapter: () =>
      fakeAdapter({
        failConnect: Object.assign(new Error("network down"), {
          code: "REMOTE_CONNECTION_FAILED",
        }),
      }),
  });
  const summary = await boot.addHost({
    hostKey: "bad",
    label: "Bad",
    url: "wss://bad",
    deviceToken: "t",
  });
  assert.equal(summary.connected, false);
  // The record persists so the next boot can retry.
  const listed = await boot.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].hostKey, "bad");
  assert.equal(listed[0].connected, false);
  await boot.closeAll();
  await cleanup();
});

test("addHost on an existing hostKey rotates the live connection in place", async () => {
  const { dir, cleanup } = await tmpDir();
  const router = createBackendRouter();
  const adapters = [];
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    buildAdapter: (record) => {
      const adapter = fakeAdapter({ sessions: [fakeSession(`s-${record.hostKey}`)] });
      adapters.push(adapter);
      return adapter;
    },
  });
  await boot.addHost({ hostKey: "a", label: "A", url: "wss://a", deviceToken: "t1" });
  await boot.addHost({ hostKey: "a", label: "A", url: "wss://a", deviceToken: "t2" });
  assert.equal(adapters.length, 2);
  // The first adapter is closed once the second rotates in.
  assert.equal(adapters[0].state, "disconnected");
  assert.equal(adapters[1].state, "connected");
  // The stale connection's close must not drop the replacement's registration.
  assert.ok(router.backendForHost("a"));
  const listed = await boot.list();
  assert.equal(listed.length, 1);
  await boot.closeAll();
  await cleanup();
});

test("removeHost closes the live connection and drops the record", async () => {
  const { dir, cleanup } = await tmpDir();
  const router = createBackendRouter();
  const adapters = [];
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router,
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    buildAdapter: () => {
      const adapter = fakeAdapter({ sessions: [fakeSession("s1")] });
      adapters.push(adapter);
      return adapter;
    },
  });
  await boot.addHost({ hostKey: "a", label: "A", url: "wss://a", deviceToken: "t" });
  await boot.removeHost("a");
  assert.equal(adapters[0].state, "disconnected");
  assert.equal(router.backendForHost("a"), null);
  // After removeHost the id fails closed instead of reaching a local handler.
  await assert.rejects(
    router.route(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId("a", "s1") }]),
    (error) => error.errorCode === "HOST_UNAVAILABLE",
  );
  assert.deepEqual(await boot.list(), []);
  await boot.closeAll();
  await cleanup();
});

test("list surface strips device tokens even when the record is on disk", async () => {
  const { dir, cleanup } = await tmpDir();
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router: createBackendRouter(),
    emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" },
    buildAdapter: () => fakeAdapter(),
  });
  await boot.addHost({
    hostKey: "h",
    label: "Home",
    url: "wss://home",
    deviceToken: "device-secret",
  });
  const listed = await boot.list();
  // The summary shape has exactly these five fields: the four the pairing UX
  // has always shown, plus the transport marker the SSH bootstrap added. A
  // record with no metadata is a direct host, so the marker defaults there.
  assert.deepEqual(Object.keys(listed[0]).sort(), [
    "connected",
    "hostKey",
    "label",
    "transport",
    "url",
  ]);
  assert.equal(listed[0].transport, "direct");
  await boot.closeAll();
  await cleanup();
});
