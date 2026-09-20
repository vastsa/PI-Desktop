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
