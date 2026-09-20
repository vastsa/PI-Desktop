import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createSshBootstrap, synthesizeSshHostKey } = await import(
  "../electron/main/remote/ssh-bootstrap.ts"
);
const { sshHostRecord, sshMetadataOf, transportOf } = await import(
  "../electron/main/bootstrap/remote-hosts.ts"
);

const VERSION = "0.15.1-beta.5";
const ARTIFACT_NAME = `pi-host-${VERSION}-linux-x64.tar.gz`;
const ARTIFACT_URL = `https://github.com/vastsa/PI-Desktop/releases/download/v${VERSION}/${ARTIFACT_NAME}`;
const DIGEST = "0123456789abcdef".repeat(4);
const RESERVED_PORT = 49_152;

/** The two lines the remote script prints on success, with `41234` as the
 * loopback port the host bound on the remote machine. */
function scriptStdout({ version = VERSION, token = "ppt1.abc" } = {}) {
  return [
    "PI_HOST_BOOTSTRAP download",
    "PI_HOST_BOOTSTRAP ok",
    `PI_HOST_READY ${JSON.stringify({ hostId: "host_x", host: "127.0.0.1", port: 41_234, version })}`,
    `PI_HOST_PAIRING_TOKEN ${JSON.stringify({ token, expiresAt: 1_893_456_000_000 })}`,
  ].join("\n");
}

/** Stands in for the system `ssh` transport. Records every call so the test can
 * assert the orchestrator's ordering without spawning a process. */
function fakeTransport({ uname = "Linux\nx86_64\n", stdout = scriptStdout(), stderr = "" } = {}) {
  const calls = { exec: [], uploads: [], forwards: [], disposeCount: 0 };
  const forward = {
    localPort: 0,
    closed: 0,
    async close() {
      forward.closed += 1;
    },
  };
  return {
    calls,
    openedForward: forward,
    async exec(command) {
      calls.exec.push(command);
      return { stdout: uname, stderr: "", code: 0 };
    },
    async execWithInput(command, input) {
      calls.uploads.push({ command, input });
      return { stdout, stderr, code: 0 };
    },
    async forward(options) {
      calls.forwards.push(options);
      forward.localPort = options.localPort;
      return forward;
    },
    dispose() {
      calls.disposeCount += 1;
    },
  };
}

function harness({ transport = fakeTransport(), checksum, ports = [RESERVED_PORT], exchange } = {}) {
  const built = [];
  const fetched = [];
  const pairings = [];
  const progress = [];
  let portIndex = 0;
  const bootstrap = createSshBootstrap({
    version: VERSION,
    buildTransport: (target) => {
      built.push(target);
      return transport;
    },
    fetchChecksum: async (url) => {
      fetched.push(url);
      return checksum ?? `${DIGEST}  ${ARTIFACT_NAME}\n`;
    },
    reservePort: async () => ports[Math.min(portIndex++, ports.length - 1)],
    exchangePairing: async (input) => {
      pairings.push(input);
      return exchange ? await exchange(input) : "dt_secret";
    },
    onProgress: (step) => progress.push(step),
  });
  return { bootstrap, built, fetched, pairings, progress, transport };
}

function request(overrides = {}) {
  return { label: "Prod box", host: "remote.example", port: 2222, user: "deploy", ...overrides };
}

/** Await `run()` and return the error it rejects with; fail when it resolves. */
async function catchError(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

test("bootstrap probes, installs, forwards, and pairs in order", async () => {
  const { bootstrap, built, fetched, pairings, progress, transport } = harness();
  const outcome = await bootstrap.bootstrap(request());

  // The artifact is chosen for the remote platform, never the desktop's.
  assert.deepEqual(built, [{ host: "remote.example", port: 2222, user: "deploy" }]);
  assert.equal(built.length, 1);
  assert.deepEqual(transport.calls.exec, ["uname -s && uname -m"]);
  // The desktop holds the trust anchor: the digest from the published file.
  assert.equal(fetched[0], `${ARTIFACT_URL}.sha256`);

  assert.deepEqual(outcome.steps, [
    "probe",
    "resolve-release",
    "download-checksum",
    "install",
    "forward",
    "pair",
  ]);
  assert.deepEqual(progress, outcome.steps, "each step is reported once, in order");
  assert.equal(outcome.hostKey, "ssh-remote.example-prod-box");
  assert.equal(outcome.label, "Prod box");
  assert.equal(outcome.deviceToken, "dt_secret");
  assert.deepEqual(outcome.ssh, {
    host: "remote.example",
    port: 2222,
    user: "deploy",
    remotePort: 41_234,
    version: VERSION,
  });

  // One tunnel: reserved here, bound to the port the host reported remotely.
  assert.deepEqual(transport.calls.forwards, [
    { localPort: RESERVED_PORT, remoteHost: "127.0.0.1", remotePort: 41_234 },
  ]);
  assert.equal(outcome.forward, transport.openedForward);
  assert.equal(outcome.url, `ws://127.0.0.1:${RESERVED_PORT}/v1/racp/ws`);
  assert.equal(transport.calls.disposeCount, 0, "the caller adopts the forward, so its transport must stay alive");

  // Pairing spends the single-use token over the forwarded URL only.
  assert.deepEqual(pairings, [
    { url: `ws://127.0.0.1:${RESERVED_PORT}/v1/racp/ws`, pairingToken: "ppt1.abc", label: "Prod box" },
  ]);

  // What travelled over SSH is the script with the pinned digest and URL, not
  // any executable bytes.
  const upload = transport.calls.uploads[0];
  assert.equal(upload.command, "sh -s");
  assert.ok(upload.input.includes(`EXPECTED_SHA256='${DIGEST}'`));
  assert.ok(upload.input.includes(`ARTIFACT_URL='${ARTIFACT_URL}'`));
  // No `remotePort` in the request: the host picks a free port and reports it.
  assert.ok(upload.input.includes("PORT='0'"));
});

test("a remote host running a different release is refused before the forward", async () => {
  const transport = fakeTransport({ stdout: scriptStdout({ version: "0.14.9" }) });
  const { bootstrap, pairings } = harness({ transport });
  const error = await catchError(() => bootstrap.bootstrap(request()));
  assert.equal(error.errorCode, "HOST_VERSION_MISMATCH");
  assert.equal(error.remote, "0.14.9");
  assert.equal(error.local, VERSION);
  assert.deepEqual(transport.calls.forwards, [], "a mismatched host must not get a tunnel");
  assert.deepEqual(pairings, []);
  assert.equal(transport.calls.disposeCount, 1, "the failed attempt must shut its own transport down");
});

test("an unpublished target fails without downloading anything", async () => {
  // arm64 Linux is in the release matrix's shape but not in its published set.
  const transport = fakeTransport({ uname: "Linux\naarch64\n" });
  const { bootstrap, fetched } = harness({ transport });
  const error = await catchError(() => bootstrap.bootstrap(request()));
  assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
  assert.equal(error.target, "linux-arm64");
  assert.deepEqual(fetched, [], "no checksum request for a bundle that does not exist");
  assert.deepEqual(transport.calls.uploads, []);
});

test("a checksum file with no digest for this artifact fails the bootstrap", async () => {
  const transport = fakeTransport();
  const { bootstrap } = harness({ transport, checksum: `${DIGEST}  pi-host-0.15.0-linux-x64.tar.gz\n` });
  const error = await catchError(() => bootstrap.bootstrap(request()));
  assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
  assert.deepEqual(transport.calls.uploads, [], "the script must not run without a digest to verify");
});

test("a failed remote script reports the step it failed at", async () => {
  const transport = fakeTransport({
    stdout: "PI_HOST_BOOTSTRAP download\nPI_HOST_BOOTSTRAP_FAILED checksum-mismatch\n",
    stderr: "PI_HOST_BOOTSTRAP_FAILED checksum-mismatch\n",
  });
  const { bootstrap } = harness({ transport });
  const error = await catchError(() => bootstrap.bootstrap(request()));
  assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
  assert.equal(error.step, "checksum-mismatch");
  assert.match(error.message, /did not match the published SHA-256/);
  assert.deepEqual(transport.calls.forwards, []);
  assert.equal(transport.calls.disposeCount, 1);
});

test("a missing remote Node.js is reported as a Node version requirement", async () => {
  const transport = fakeTransport({
    stdout: "PI_HOST_FAILED {\"code\":\"HOST_BOOTSTRAP_FAILED\",\"step\":\"missing-node\"}\n",
  });
  const { bootstrap } = harness({ transport });
  const error = await catchError(() => bootstrap.bootstrap(request()));
  assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
  assert.equal(error.step, "missing-node");
  assert.match(error.message, /no Node\.js.*22/);
});

test("a failed pairing exchange closes the forward it can no longer use", async () => {
  const transport = fakeTransport();
  const { bootstrap } = harness({
    transport,
    exchange: async () => {
      throw Object.assign(new Error("pairing token already spent"), { errorCode: "REMOTE_CONNECTION_FAILED" });
    },
  });
  const error = await catchError(() => bootstrap.bootstrap(request()));
  assert.equal(error.errorCode, "REMOTE_CONNECTION_FAILED");
  assert.equal(transport.openedForward.closed, 1, "a forward with no paired token is dead weight");
});

test("arguments that would reach the ssh argv are refused before any transport exists", async () => {
  const cases = [
    { name: "empty host", patch: { host: "" }, field: "host" },
    { name: "host that reads as an ssh option", patch: { host: "-oProxyCommand=evil" }, field: "host" },
    { name: "user that reads as an ssh option", patch: { user: "-x" }, field: "user" },
    { name: "port outside the tcp range", patch: { port: 70_000 }, field: "port" },
    { name: "hostKey containing ':'", patch: { hostKey: "remote:host" }, field: "hostKey" },
  ];
  for (const { name, patch, field } of cases) {
    const { bootstrap, built } = harness();
    const error = await catchError(() => bootstrap.bootstrap(request(patch)));
    assert.equal(error.errorCode, "INVALID_ARGUMENT", name);
    assert.equal(error.field, field, name);
    assert.deepEqual(built, [], `${name}: no ssh process may be spawned`);
  }
});

test("synthesizeSshHostKey folds an IPv6 literal and is stable", () => {
  const ipv6 = synthesizeSshHostKey({ host: "2001:db8::1", user: "deploy" }, "Prod Box");
  // The key lands inside `remote:<hostKey>:<sessionId>`, where a colon would
  // split the routing id, so the address is folded to dashes instead.
  assert.ok(!ipv6.includes(":"), "hostKey must never contain ':'");
  assert.equal(ipv6, "ssh-2001-db8-1-prod-box");
  assert.equal(synthesizeSshHostKey({ host: "2001:db8::1", user: "deploy" }, "Prod Box"), ipv6);
  // The user is not part of the key: the same machine reached as two users
  // stays one host, and the label keeps the two rows apart.
  assert.equal(
    synthesizeSshHostKey({ host: "2001:db8::1", user: "other" }, "Prod Box"),
    ipv6,
  );
});

test("sshMetadataOf parses the descriptor a bootstrapped host is stored with", () => {
  const descriptor = {
    host: "remote.example",
    port: 2222,
    user: "deploy",
    identityFile: "/home/deploy/.ssh/id_ed25519",
    remotePort: 41_234,
    version: VERSION,
  };
  const metadata = { transport: "ssh", ssh: descriptor };
  assert.deepEqual(sshMetadataOf({ hostKey: "h", label: "H", url: "u", deviceToken: "t", metadata }), descriptor);
  assert.equal(transportOf({ hostKey: "h", label: "H", url: "u", deviceToken: "t", metadata }), "ssh");
  // Absent metadata is a record written before the SSH bootstrap existed.
  assert.equal(transportOf({ hostKey: "h", label: "H", url: "u", deviceToken: "t" }), "direct");

  // Round trip through the writer the boot layer persists with.
  const written = sshHostRecord({
    hostKey: "k",
    label: "L",
    url: "u",
    deviceToken: "t",
    ssh: descriptor,
  });
  assert.equal(written.metadata.transport, "ssh");
  assert.deepEqual(sshMetadataOf(written), descriptor);
});

test("sshMetadataOf refuses direct, missing, and malformed descriptors", () => {
  const descriptor = {
    host: "remote.example",
    port: 2222,
    user: "deploy",
    identityFile: "/home/deploy/.ssh/id_ed25519",
    remotePort: 41_234,
    version: VERSION,
  };
  const record = (metadata) => ({ hostKey: "h", label: "H", url: "u", deviceToken: "t", metadata });

  assert.equal(sshMetadataOf(record({ transport: "direct", ssh: descriptor })), null);
  assert.equal(sshMetadataOf(record({ transport: "direct" })), null);
  assert.equal(sshMetadataOf(record(undefined)), null);
  assert.equal(sshMetadataOf(record({ ssh: descriptor })), null, "metadata without a transport is not ssh");
  assert.equal(sshMetadataOf(record({ transport: "ssh" })), null);
  assert.equal(sshMetadataOf(record({ transport: "ssh", ssh: "not-an-object" })), null);
  assert.equal(sshMetadataOf(record({ transport: "ssh", ssh: { ...descriptor, host: "   " } })), null);

  // `remote-hosts.json` is user-editable, so a bad port must degrade to "not an
  // SSH host" rather than reaching an `ssh -L` argument.
  for (const remotePort of [undefined, 0, -1, 65_536, 41_234.5, "41234"]) {
    assert.equal(
      sshMetadataOf(record({ transport: "ssh", ssh: { ...descriptor, remotePort } })),
      null,
      `remotePort ${String(remotePort)}`,
    );
  }
});
