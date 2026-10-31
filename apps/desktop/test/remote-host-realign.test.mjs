import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createRemoteHostRealigner, REALIGN_RETRY_AFTER_MS } = await import(
  "../electron/main/remote/remote-host-realign.ts"
);
const { createRemoteHostsBoot } = await import(
  "../electron/main/bootstrap/remote-hosts.ts"
);
const { createSshTunnelManager } = await import(
  "../electron/main/remote/ssh-tunnel.ts"
);
const { createBackendRouter } = await import(
  "../electron/main/remote/backend-router.ts"
);

const DESKTOP_VERSION = "0.18.0";
const OLD_VERSION = "0.17.0";

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
  const dir = await mkdtemp(join(tmpdir(), "remote-realign-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A record for a host that was paired over SSH at `version`. */
function sshRecord({ version = OLD_VERSION, sshSecret = "login-secret", auth = "password", ssh: sshOverrides = {} } = {}) {
  // `null` is the explicit "the stored secret is gone" case: an omitted
  // argument keeps the default, so `undefined` cannot express it.
  const storedSecret = sshSecret === null ? undefined : sshSecret;
  return {
    hostKey: "ssh-box",
    label: "Box",
    url: "ws://127.0.0.1:4999/v1/racp/ws",
    deviceToken: "paired-token",
    ...(storedSecret ? { sshSecret: storedSecret } : {}),
    metadata: {
      transport: "ssh",
      ssh: {
        host: "box.local",
        user: "root",
        ...(auth === "password" ? { auth: "password" } : {}),
        remotePort: 4000,
        version,
        hostId: "host-id",
        ...sshOverrides,
      },
    },
  };
}

function readyLine(version, port, hostId = "host-id") {
  return `PI_HOST_READY ${JSON.stringify({ hostId, host: "127.0.0.1", port, version })}`;
}

function fakeAdapter({ capabilities, failConnect } = {}) {
  const listeners = new Set();
  let state = "disconnected";
  const adapter = {
    state: () => state,
    async connect() {
      if (failConnect) throw failConnect;
      state = "connected";
    },
    async close() {
      state = "disconnected";
      listeners.clear();
    },
    client: {
      request: async (method, params) => {
        if (method === "session/list") return { sessions: [] };
        if (method === "events/subscribe") {
          return {
            subscriptionId: `sub-${params.sessionId ?? "host"}`,
            starting: { epoch: "e1", sequence: 1 },
            replayComplete: true,
          };
        }
        return { ok: true };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  // Only present when a test wants the handshake capabilities observed: the
  // boot layer treats a missing reporter as "not known", never as "missing".
  if (capabilities) adapter.workspaceCapabilities = () => capabilities;
  return adapter;
}

/* ------------------------------------------------------------------ */
/* Decision and record-replacement unit coverage                       */
/* ------------------------------------------------------------------ */

test("realignment is refused for hosts it cannot replay and throttled per release", () => {
  let now = 1_000;
  const realigner = createRemoteHostRealigner({
    version: DESKTOP_VERSION,
    bootstrap: async () => {
      throw new Error("not used");
    },
    upsert: async () => undefined,
    now: () => now,
  });

  assert.equal(realigner.decide({ hostKey: "direct", label: "D", url: "wss://d", deviceToken: "t" }), "no-ssh-descriptor");
  assert.equal(realigner.decide(sshRecord({ sshSecret: null })), "no-credentials");
  assert.equal(realigner.decide(sshRecord({ auth: "key", sshSecret: null })), "attempt");
  assert.equal(realigner.decide(sshRecord(), { force: true }), "attempt");
  assert.equal(realigner.decide(sshRecord()), "attempt");
});

test("a same-release failure cooldown survives restarts and a new release retries immediately", async () => {
  let now = 5_000;
  const attempts = [];
  let persisted = sshRecord();
  const createRealigner = (version) => createRemoteHostRealigner({
    version,
    bootstrap: async (request) => {
      attempts.push(request);
      throw new Error("release not published yet");
    },
    upsert: async (record) => { persisted = record; },
    now: () => now,
  });

  const realigner = createRealigner(DESKTOP_VERSION);
  assert.equal(await realigner.realign(persisted), null, "a failed attempt resolves to null");
  assert.equal(persisted.metadata.piHostRealignment.succeeded, false);
  assert.equal(realigner.decide(persisted), "cooldown", "the same release must not retry immediately");

  const restarted = createRealigner(DESKTOP_VERSION);
  assert.equal(restarted.decide(persisted), "cooldown", "the persisted failure survives an app restart");
  now += REALIGN_RETRY_AFTER_MS;
  assert.equal(restarted.decide(persisted), "attempt", "a transient failure may be retried later");
  assert.equal(createRealigner("0.19.0").decide(persisted), "attempt", "a new desktop release retries immediately");
  assert.equal(attempts.length, 1);
});

test("a realignment replaces the record with the re-paired host and closes a failed forward", async () => {
  const stored = [];
  const closed = [];
  const remote = { host: "box.local", remotePort: 4100, version: DESKTOP_VERSION, hostId: "new-host", auth: "password", user: "root" };
  const realigner = createRemoteHostRealigner({
    version: DESKTOP_VERSION,
    bootstrap: async (request) => {
      assert.equal(request.hostKey, "ssh-box");
      assert.equal(request.label, "Box");
      assert.equal(request.password, "login-secret", "the stored SSH secret is replayed");
      assert.equal(request.remotePort, 0, "the replacement host picks its own loopback port");
      return {
        hostKey: request.hostKey,
        label: request.label,
        url: "ws://127.0.0.1:5400/v1/racp/ws",
        deviceToken: "fresh-token",
        ssh: remote,
        forward: { localPort: 5400, close: async () => closed.push("forward") },
        steps: [],
      };
    },
    upsert: async (record) => stored.push(record),
  });

  const result = await realigner.realign(sshRecord());
  assert.equal(result.record.url, "ws://127.0.0.1:5400/v1/racp/ws");
  assert.equal(result.record.deviceToken, "fresh-token");
  assert.equal(result.record.sshSecret, "login-secret");
  assert.deepEqual(result.record.metadata.ssh, remote);
  assert.equal(result.record.metadata.transport, "ssh");
  assert.deepEqual(stored, [result.record], "the refreshed record is persisted before the caller reconnects");
  assert.deepEqual(closed, []);
  assert.equal(realigner.decide(sshRecord()), "aligned", "an aligned release is not attempted again");
  assert.equal(result.record.metadata.piHostRealignment.succeeded, true);
  const restarted = createRemoteHostRealigner({
    version: DESKTOP_VERSION,
    bootstrap: async () => { throw new Error("the successful marker must prevent another install"); },
    upsert: async () => undefined,
  });
  assert.equal(restarted.decide(result.record), "aligned", "a successful release marker survives app restart");

  const failing = createRemoteHostRealigner({
    version: DESKTOP_VERSION,
    bootstrap: async () => ({
      hostKey: "ssh-box",
      label: "Box",
      url: "ws://127.0.0.1:5400/v1/racp/ws",
      deviceToken: "fresh-token",
      ssh: remote,
      forward: { localPort: 5400, close: async () => closed.push("orphan") },
      steps: [],
    }),
    upsert: async () => {
      throw new Error("disk full");
    },
  });
  assert.equal(await failing.realign(sshRecord()), null);
  assert.deepEqual(closed, ["orphan"], "a forward the caller never adopts is closed here");
});

/* ------------------------------------------------------------------ */
/* Boot-level: the user path from a stale paired host back to ready     */
/* ------------------------------------------------------------------ */

/** Fake SSH side shared by the tunnel probe and the bootstrap script. */
function sshFixture() {
  const state = { remoteVersion: OLD_VERSION, bootstraps: 0, probes: 0, ports: 5400 };
  const tunnels = {
    exec: async () => ({ code: 0, stdout: "Linux\nx86_64\n", stderr: "" }),
    execWithInput: async () => {
      state.probes += 1;
      return { code: 0, stdout: readyLine(state.remoteVersion, 4000), stderr: "" };
    },
    forward: async ({ localPort }) => ({ localPort, close: async () => undefined }),
    dispose: () => undefined,
  };
  const bootstrap = {
    exec: async () => ({ code: 0, stdout: "Linux\nx86_64\n", stderr: "" }),
    execWithInput: async () => {
      state.bootstraps += 1;
      // The verified install lands the desktop's release and restarts the host.
      state.remoteVersion = DESKTOP_VERSION;
      state.ports += 1;
      return {
        code: 0,
        stderr: "",
        stdout: `${readyLine(DESKTOP_VERSION, state.ports)}\nPI_HOST_PAIRING_TOKEN ${JSON.stringify({ token: "ppt1.fixture", expiresAt: 1893456000000 })}`,
      };
    },
    forward: async ({ localPort }) => ({ localPort, close: async () => undefined }),
    dispose: () => undefined,
  };
  return { state, tunnels: () => tunnels, bootstrap: () => bootstrap };
}

function bootFor(dir, fixture, { capabilities, router } = {}) {
  let port = 6100;
  return createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router: router ?? createBackendRouter(),
    emit: () => undefined,
    clientInfo: { name: "test", version: DESKTOP_VERSION },
    buildAdapter: () => fakeAdapter({ capabilities }),
    tunnels: createSshTunnelManager({
      reservePort: async () => (port += 1),
      buildTransport: () => fixture.tunnels(),
    }),
    sshBootstrap: {
      buildTransport: () => fixture.bootstrap(),
      fetchChecksum: async () => `${"a".repeat(64)}  pi-host-${DESKTOP_VERSION}-linux-x64.tar.gz`,
      reservePort: async () => (port += 1),
      exchangePairing: async () => "realigned-device-token",
    },
    log: () => undefined,
  });
}

test("a host left behind by an upgrade is realigned on connect and re-paired in place", async () => {
  const { dir, cleanup } = await tmpDir();
  const fixture = sshFixture();
  const boot = bootFor(dir, fixture);
  try {
    await boot.registry.upsert(sshRecord());
    const connected = await boot.open();
    assert.equal(connected, 1, "the host is reachable after the automatic realignment");
    assert.equal(fixture.state.bootstraps, 1);
    assert.equal(fixture.state.remoteVersion, DESKTOP_VERSION);

    const [summary] = await boot.list();
    assert.equal(summary.connected, true);
    assert.equal(summary.transport, "ssh");

    // The re-paired credentials and descriptor are the ones now on disk.
    const file = JSON.parse(await readFile(join(dir, "remote-hosts.json"), "utf8"));
    const stored = file.hosts[0];
    assert.equal(stored.metadata.ssh.version, DESKTOP_VERSION);
    assert.equal(stored.metadata.ssh.hostId, "host-id");
    assert.notEqual(stored.url, "ws://127.0.0.1:4999/v1/racp/ws", "the record follows the re-opened forward");

    // A second open reuses the live connection instead of re-provisioning.
    await boot.open();
    assert.equal(fixture.state.bootstraps, 1, "an aligned host is never re-provisioned again");
  } finally {
    await boot.closeAll();
    await cleanup();
  }
});

test("a host that stays unusable after realignment warns once and keeps the mismatch visible", async () => {
  const { dir, cleanup } = await tmpDir();
  const fixture = sshFixture();
  fixture.state.remoteVersion = DESKTOP_VERSION;
  const boot = bootFor(dir, fixture, { capabilities: { workspaceTools: false, workspaceFiles: false } });
  try {
    await boot.registry.upsert(sshRecord({ version: DESKTOP_VERSION }));
    await assert.rejects(boot.ensureReady("ssh-box"), { errorCode: "HOST_VERSION_MISMATCH" });
    assert.equal(fixture.state.bootstraps, 1, "the same-version capability gap is realigned once");
    assert.equal((await boot.list())[0].status, "action-required");

    await assert.rejects(boot.ensureReady("ssh-box"), { errorCode: "HOST_VERSION_MISMATCH" });
    assert.equal(fixture.state.bootstraps, 1, "an aligned release is not re-provisioned on every retry");

    await boot.closeAll();
    const restarted = bootFor(dir, fixture, { capabilities: { workspaceTools: false, workspaceFiles: false } });
    try {
      await assert.rejects(restarted.ensureReady("ssh-box"), { errorCode: "HOST_VERSION_MISMATCH" });
      assert.equal(fixture.state.bootstraps, 1, "the persisted success marker prevents a restart loop");

      // The user asking explicitly still gets a fresh attempt.
      await assert.rejects(restarted.reconnectHost("ssh-box"), { errorCode: "HOST_VERSION_MISMATCH" });
      assert.equal(fixture.state.bootstraps, 2);
    } finally {
      await restarted.closeAll();
    }
  } finally {
    await boot.closeAll();
    await cleanup();
  }
});

test("a password host whose stored secret is gone is never replayed over SSH", async () => {
  const { dir, cleanup } = await tmpDir();
  const fixture = sshFixture();
  fixture.state.remoteVersion = DESKTOP_VERSION;
  const boot = bootFor(dir, fixture, { capabilities: { workspaceTools: false, workspaceFiles: false } });
  try {
    await boot.registry.upsert(sshRecord({ version: DESKTOP_VERSION, sshSecret: null }));
    await assert.rejects(boot.ensureReady("ssh-box"), { errorCode: "HOST_VERSION_MISMATCH" });
    assert.equal(fixture.state.bootstraps, 0, "without the secret there is nothing to replay");
  } finally {
    await boot.closeAll();
    await cleanup();
  }
});

test("realignment leaves a direct-paired host untouched", async () => {
  const { dir, cleanup } = await tmpDir();
  const fixture = sshFixture();
  const failure = Object.assign(new Error("version"), { errorCode: "HOST_VERSION_MISMATCH" });
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: reversibleEncryption(),
    router: createBackendRouter(),
    emit: () => undefined,
    clientInfo: { name: "test", version: DESKTOP_VERSION },
    buildAdapter: () => fakeAdapter({ failConnect: failure }),
    tunnels: createSshTunnelManager({
      reservePort: async () => 6200,
      buildTransport: () => fixture.tunnels(),
    }),
    sshBootstrap: {
      buildTransport: () => fixture.bootstrap(),
      exchangePairing: async () => "unused",
    },
    log: () => undefined,
  });
  try {
    await boot.registry.upsert({ hostKey: "direct", label: "Direct", url: "wss://direct", deviceToken: "t" });
    await assert.rejects(boot.ensureReady("direct"), { errorCode: "HOST_VERSION_MISMATCH" });
    assert.equal(fixture.state.bootstraps, 0, "a URL-paired host has no SSH descriptor to replay");
  } finally {
    await boot.closeAll();
    await cleanup();
  }
});

test("an unexpected Host identity is never treated as an upgrade mismatch", async () => {
  const { dir, cleanup } = await tmpDir();
  const fixture = sshFixture();
  fixture.state.remoteVersion = OLD_VERSION;
  const boot = bootFor(dir, fixture);
  try {
    await boot.registry.upsert(sshRecord({ ssh: { hostId: "expected-host" } }));
    await assert.rejects(boot.ensureReady("ssh-box"), { errorCode: "HOST_AUTH_FAILED" });
    assert.equal(fixture.state.bootstraps, 0, "a different Host identity must never be re-paired automatically");
  } finally {
    await boot.closeAll();
    await cleanup();
  }
});
