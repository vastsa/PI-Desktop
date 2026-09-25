import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createSshTunnelManager, racpUrlForLocalPort, sshTargetOf } = await import(
  "../electron/main/remote/ssh-tunnel.ts"
);
const { sshCommonArgs } = await import("../electron/main/remote/ssh-transport.ts");

const VERSION = "0.15.1-beta.5";
const SSH = {
  host: "remote.example",
  port: 2222,
  user: "deploy",
  identityFile: "/home/deploy/.ssh/id_ed25519",
  remotePort: 41_234,
  version: VERSION,
};

function fakeForward(localPort, onClose = () => undefined) {
  const forward = {
    localPort,
    closes: 0,
    async close() {
      forward.closes += 1;
      onClose();
    },
  };
  return forward;
}

/**
 * Manager wired to fakes: no `ssh` is spawned and the reserved loopback port
 * comes from a fixed sequence. `armFailure` makes the *next* transport the
 * factory builds fail its forward, which is how a refused connection looks.
 */
function harness({ ports = [41_001, 41_002, 41_003, 41_004, 41_005] } = {}) {
  const built = [];
  const transports = [];
  const processesByPort = new Map();
  let portIndex = 0;
  let pendingFailure = null;
  const manager = createSshTunnelManager({
    reservePort: async () => ports[Math.min(portIndex++, ports.length - 1)],
    isForwardReachable: async (localPort) => processesByPort.get(localPort)?.running === true,
    buildTransport: (ssh) => {
      built.push(ssh);
      const process = {
        running: true,
        exit() {
          process.running = false;
        },
        fail() {
          process.running = false;
        },
      };
      const entry = {
        ssh,
        process,
        forwards: [],
        disposed: 0,
        lastForward: null,
        nextFailure: pendingFailure,
        throwOnDispose: false,
      };
      pendingFailure = null;
      transports.push(entry);
      return {
        exec: async () => {
          throw new Error("the tunnel never execs");
        },
        execWithInput: async () => {
          throw new Error("the tunnel never execs");
        },
        async forward(options) {
          entry.forwards.push(options);
          if (entry.nextFailure) {
            const failure = entry.nextFailure;
            entry.nextFailure = null;
            throw failure;
          }
          entry.lastForward = fakeForward(options.localPort, () => entry.process.exit());
          processesByPort.set(options.localPort, entry.process);
          return entry.lastForward;
        },
        dispose() {
          entry.disposed += 1;
          entry.process.exit();
          if (entry.throwOnDispose) throw new Error("ssh process already exited");
        },
      };
    },
  });
  return { manager, built, transports, armFailure: (error) => { pendingFailure = error; } };
}

test("racpUrlForLocalPort is the loopback RACP endpoint of a forward", () => {
  assert.equal(racpUrlForLocalPort(1234), "ws://127.0.0.1:1234/v1/racp/ws");
});

test("sshTargetOf keeps only the fields ssh can use", () => {
  const target = sshTargetOf(SSH);
  assert.deepEqual(target, {
    host: "remote.example",
    port: 2222,
    user: "deploy",
    identityFile: "/home/deploy/.ssh/id_ed25519",
  });
  // `remotePort` and `version` are RACP facts, not ssh arguments.
  assert.ok(!("remotePort" in target));
  assert.ok(!("version" in target));
  // Absent optional fields must be absent, not `undefined` entries: an argv
  // containing the string "undefined" would reach ssh.
  assert.deepEqual(sshTargetOf({ host: "h", remotePort: 1, version: VERSION }), { host: "h" });
  assert.deepEqual(
    sshTargetOf({ host: "h", port: undefined, user: "", identityFile: undefined, remotePort: 1, version: VERSION }),
    { host: "h" },
  );
});

test("the descriptor becomes an ssh argv that never prompts", () => {
  const args = sshCommonArgs(sshTargetOf(SSH));
  const hasOption = (name, value) => args.some((arg, index) => arg === name && args[index + 1] === value);
  // There is no terminal behind the spawn, so a password prompt would hang.
  assert.ok(hasOption("-o", "BatchMode=yes"));
  assert.ok(hasOption("-o", "StrictHostKeyChecking=accept-new"));
  // A forward that cannot be set up must fail the connection, not linger.
  assert.ok(hasOption("-o", "ExitOnForwardFailure=yes"));
  assert.ok(hasOption("-p", "2222"));
  assert.ok(hasOption("-i", "/home/deploy/.ssh/id_ed25519"));
  assert.equal(args.at(-1), "deploy@remote.example");

  // Without a user the destination is the bare host, and no port/identity flags
  // are invented for it.
  assert.deepEqual(sshCommonArgs({ host: "h" }).at(-1), "h");
  assert.ok(!sshCommonArgs({ host: "h" }).includes("-p"));
});

test("open reuses the forward for a host key instead of stacking tunnels", async () => {
  const { manager, built, transports } = harness();
  const first = await manager.open("k1", SSH);
  const second = await manager.open("k1", SSH);

  assert.equal(second, first, "the same tunnel object is handed out again");
  assert.equal(first.url, racpUrlForLocalPort(first.localPort));
  assert.equal(built.length, 1);
  assert.equal(built[0], SSH);
  assert.equal(transports.length, 1);
  assert.equal(transports[0].forwards.length, 1);
  assert.deepEqual(transports[0].forwards[0], {
    localPort: first.localPort,
    remoteHost: "127.0.0.1",
    remotePort: SSH.remotePort,
  });
});

test("concurrent opens for one host share the in-progress forward", async () => {
  const { manager, built, transports } = harness();
  const [first, second] = await Promise.all([manager.open("k1", SSH), manager.open("k1", SSH)]);

  assert.equal(first, second);
  assert.equal(built.length, 1);
  assert.equal(transports.length, 1);
  assert.equal(transports[0].forwards.length, 1);
});

test("open replaces a dead forward without disturbing another host", async () => {
  const { manager, transports } = harness();
  const first = await manager.open("k1", SSH);
  const other = await manager.open("k2", { ...SSH, remotePort: 50_000 });

  transports[0].process.exit();
  const reopened = await manager.open("k1", SSH);

  assert.equal(transports.length, 3, "a dead ssh child must be replaced by a fresh process");
  assert.notEqual(reopened.localPort, first.localPort);
  assert.equal(reopened.url, racpUrlForLocalPort(41_003));
  assert.equal(transports[0].lastForward.closes, 1);
  assert.equal(transports[0].disposed, 1);
  assert.equal(transports[1].lastForward.closes, 0, "recovering k1 must leave k2's forward open");
  assert.equal(transports[1].disposed, 0);
  assert.equal(await manager.open("k2", { ...SSH, remotePort: 50_000 }), other);

  transports[1].process.fail();
  const recoveredOther = await manager.open("k2", { ...SSH, remotePort: 50_000 });
  assert.notEqual(recoveredOther.url, other.url, "an errored ssh child must also be replaced");
  assert.equal(recoveredOther.url, racpUrlForLocalPort(41_004));
  assert.equal(transports.length, 4);
  assert.equal(transports[1].disposed, 1);
  assert.equal(transports[2].lastForward.closes, 0, "recovering k2 must leave k1's new forward open");

  await manager.close("k1");
  assert.equal(transports[2].lastForward.closes, 1);
  assert.equal(transports[3].lastForward.closes, 0, "closing k1 must not close k2");
});

test("the default liveness probe replaces a forward whose listener exited", async () => {
  const processes = [];
  const manager = createSshTunnelManager({
    buildTransport: () => {
      const process = {
        server: createServer((socket) => socket.destroy()),
        running: false,
        async start(localPort) {
          await new Promise((resolve, reject) => {
            process.server.once("error", reject);
            process.server.listen(localPort, "127.0.0.1", resolve);
          });
          process.running = true;
        },
        async exit() {
          if (!process.running) return;
          process.running = false;
          await new Promise((resolve) => process.server.close(resolve));
        },
      };
      processes.push(process);
      return {
        exec: async () => { throw new Error("unused"); },
        execWithInput: async () => { throw new Error("unused"); },
        async forward({ localPort }) {
          await process.start(localPort);
          return { localPort, close: () => process.exit() };
        },
        dispose() {
          void process.exit();
        },
      };
    },
  });

  const first = await manager.open("k1", SSH);
  assert.equal(await manager.open("k1", SSH), first, "a live listener keeps its URL");
  await processes[0].exit();

  const reopened = await manager.open("k1", SSH);
  assert.equal(processes.length, 2, "an exited listener causes a new ssh transport");
  assert.notEqual(reopened.url, first.url);
  assert.equal(processes[1].running, true);
  await manager.dispose();
  await Promise.all(processes.map((process) => process.exit()));
});

test("close tears the forward down once and a later open starts a new one", async () => {
  const { manager, transports } = harness();
  await manager.open("k1", SSH);

  await manager.close("k1");
  assert.equal(transports[0].lastForward.closes, 1);
  assert.equal(transports[0].disposed, 1, "the ssh process behind the forward must be reaped");

  await manager.close("k1");
  assert.equal(transports[0].lastForward.closes, 1, "closing a host twice must be a no-op");

  // The entry is gone, so the next connect pays for a fresh forward.
  const reopened = await manager.open("k1", SSH);
  assert.equal(transports.length, 2);
  assert.equal(reopened.localPort, 41_002);
  assert.equal(reopened.url, racpUrlForLocalPort(41_002));
});

test("dispose closes every open tunnel", async () => {
  const { manager, transports } = harness();
  await manager.open("k1", SSH);
  await manager.open("k2", { ...SSH, remotePort: 50_000 });

  await manager.dispose();
  assert.equal(transports.length, 2);
  for (const entry of transports) {
    assert.equal(entry.lastForward.closes, 1, `${entry.ssh.host} forward must be closed`);
    assert.equal(entry.disposed, 1);
  }
  await manager.dispose();
  assert.equal(transports[1].lastForward.closes, 1, "dispose is idempotent");
});

test("adopt takes over the bootstrap's forward and retires the one it replaces", async () => {
  const { manager, transports } = harness();
  const opened = await manager.open("k1", SSH);
  const previous = transports[0].lastForward;

  const adopted = fakeForward(45_555);
  const tunnel = await manager.adopt("k1", SSH, adopted);
  assert.equal(tunnel.localPort, 45_555);
  assert.equal(tunnel.url, racpUrlForLocalPort(45_555));
  assert.notEqual(tunnel.localPort, opened.localPort, "the URL must follow the adopted forward");
  assert.equal(previous.closes, 1, "replacing a tunnel must not leak its ssh process");
  assert.equal(transports.length, 1, "adopting must not spawn a second ssh");

  // A host without an entry adopts straight into the registry.
  const fresh = await manager.adopt("k2", SSH, fakeForward(45_556));
  assert.equal(fresh.url, racpUrlForLocalPort(45_556));

  // Ownership moved: the host key now closes the adopted forward.
  await manager.close("k1");
  assert.equal(adopted.closes, 1);
});

test("a refused forward propagates and leaves nothing half-registered", async () => {
  const { manager, transports, armFailure } = harness();
  const refusal = Object.assign(new Error("ssh: connect to host remote.example port 2222: Connection refused"), {
    errorCode: "REMOTE_FORWARD_FAILED",
  });
  armFailure(refusal);

  await assert.rejects(
    () => manager.open("k1", SSH),
    (error) => error === refusal,
  );
  assert.equal(transports[0].forwards.length, 1);
  assert.equal(transports[0].disposed, 1, "a dead ssh client must not be left running");

  // No cached entry, so the next attempt builds a new transport.
  const tunnel = await manager.open("k1", SSH);
  assert.equal(transports.length, 2);
  assert.equal(transports[1].forwards.length, 1);
  assert.equal(tunnel.url, racpUrlForLocalPort(tunnel.localPort));
});

test("a failed open only disposes its own host transport", async () => {
  const { manager, transports, armFailure } = harness();
  const other = await manager.open("k2", { ...SSH, remotePort: 50_000 });
  const refusal = Object.assign(new Error("forward refused"), { errorCode: "REMOTE_FORWARD_FAILED" });
  armFailure(refusal);

  await assert.rejects(() => manager.open("k1", SSH), (error) => error === refusal);

  assert.equal(transports[1].disposed, 1, "the failed k1 transport is reaped");
  assert.equal(transports[0].lastForward.closes, 0, "failure on k1 must not close k2");
  assert.equal(transports[0].disposed, 0);
  assert.equal(await manager.open("k2", { ...SSH, remotePort: 50_000 }), other);
});

test("a close failure still reaps only the requested host process", async () => {
  const { manager, transports } = harness();
  await manager.open("k1", SSH);
  await manager.open("k2", { ...SSH, remotePort: 50_000 });
  transports[0].lastForward.close = async () => {
    throw new Error("forward already exited");
  };
  transports[0].throwOnDispose = true;

  await manager.close("k1");

  assert.equal(transports[0].disposed, 1, "dispose reaps the failed k1 child");
  assert.equal(transports[1].lastForward.closes, 0, "closing k1 must not touch k2");
  assert.equal(transports[1].disposed, 0);
  assert.equal((await manager.open("k2", { ...SSH, remotePort: 50_000 })).localPort, 41_002);
});
