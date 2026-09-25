/**
 * Direct tests for the SSH transport itself.
 *
 * `ssh-transport.ts` spawns processes, races a socket probe against a dead
 * `ssh`, and owns forward lifetimes, so it is driven here with fixture
 * executables instead of the real client: nothing in this file depends on a
 * network, a host key, or an ssh binary being installed. Each fixture is
 * written into `os.tmpdir()`, made executable, and removed afterwards; every
 * test is bounded so a regression cannot hang the suite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { assertSshArgument, createSystemSshTransport, reserveLocalPort } = await import(
  "../electron/main/remote/ssh-transport.ts"
);

/** Every test is bounded well below the module's own 30 s / 120 s defaults. */
const TEST_TIMEOUT_MS = 20_000;

const FIXTURES = {
  /** Prints the argv it was handed, one entry per line. */
  argvEcho: `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg"
done
`,
  /** Prints its argv between markers, then echoes its stdin. */
  argvAndStdin: `#!/bin/sh
echo "ARGV-BEGIN"
for arg in "$@"; do
  printf '%s\\n' "$arg"
done
echo "ARGV-END"
cat
`,
  /** Writes to both streams and fails, like a remote bootstrap step. */
  failing: `#!/bin/sh
echo "STDOUT-MARKER-the remote step failed"
echo "STDERR-MARKER-connection reset by peer" >&2
exit 3
`,
  /** Leaks a pairing token on stdout, then fails. */
  tokenLeak: `#!/bin/sh
echo 'PI_HOST_PAIRING_TOKEN {"token":"ppt1.secret","expiresAt":1}'
echo "bootstrap step 3 failed on the remote host"
exit 7
`,
  /** Outlives any sane timeout; `exec` makes the kill land on the sleeper. */
  sleeper: `#!/bin/sh
exec sleep 30
`,
  /** The shape of a refused connection: a diagnostic and a dead client. */
  deadSsh: `#!/bin/sh
echo "Permission denied (publickey)." >&2
exit 255
`,
};

/**
 * Stands in for `ssh` in both roles: without `-N -L` it records its pid, prints
 * its argv and exits (an exec); with them it listens on the `-L` port like a
 * real forward, recording the pid its test can poll to prove it was reaped.
 */
const NODE_FIXTURE = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");

const args = process.argv.slice(2);
const forwardAt = args.indexOf("-L");
const pidFile = process.argv[1] + (forwardAt === -1 ? ".exec.pid" : ".forward.pid");

if (forwardAt === -1) {
  fs.writeFileSync(pidFile, String(process.pid));
  fs.writeSync(1, args.join("\\n") + "\\n");
  process.exit(0);
}

const port = Number(String(args[forwardAt + 1]).split(":")[1]);
if (!Number.isInteger(port) || port <= 0) {
  fs.writeSync(2, "fixture received no usable -L argument\\n");
  process.exit(2);
}
const server = net.createServer((socket) => socket.end());
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(pidFile, String(process.pid));
});
`;

/** Write an executable fixture; its directory goes away when the test ends. */
async function writeFixture(t, body, name) {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-ssh-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
  return file;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pairIndex(argv, name, value) {
  return argv.findIndex((arg, index) => arg === name && argv[index + 1] === value);
}

function hasPair(argv, name, value) {
  return pairIndex(argv, name, value) !== -1;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `true` if something accepts a TCP connection on the loopback port. */
function portAccepts(port) {
  return new Promise((resolveAccepts) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveAccepts(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolveAccepts(false);
    });
  });
}

async function readPid(file) {
  try {
    const pid = Number.parseInt((await readFile(file, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Poll until `condition` holds, so no test depends on a fixed sleep. */
async function waitFor(condition, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    }
    await delay(25);
  }
}

async function waitForPid(file) {
  let pid = null;
  await waitFor(async () => {
    pid = await readPid(file);
    return pid !== null;
  }, `the fixture to record its pid in ${file}`);
  return pid;
}

test("exec passes the command as one argv entry behind the common options", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvEcho, "ssh-argv-echo");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });

  const plain = await transport.exec("uname -s");
  assert.equal(plain.code, 0);
  const argv = plain.stdout.split("\n").filter(Boolean);

  // A single argv entry: `uname -s` must never split into two arguments.
  assert.equal(argv.at(-1), "uname -s");
  assert.equal(argv.at(-2), "remote.example", "the command follows the destination");
  const command = argv.length - 1;
  for (const [name, value] of [
    ["-o", "BatchMode=yes"],
    ["-o", "StrictHostKeyChecking=accept-new"],
    ["-o", "ExitOnForwardFailure=yes"],
  ]) {
    const index = pairIndex(argv, name, value);
    assert.notEqual(index, -1, `${name} ${value} is missing`);
    assert.ok(index < command, `${name} ${value} must precede the command`);
  }

  const targeted = createSystemSshTransport(
    {
      host: "remote.example",
      port: 2222,
      user: "deploy",
      identityFile: "/home/deploy/.ssh/id_ed25519",
    },
    { binary, extraOptions: ["-o", "ServerAliveInterval=15"] },
  );
  const withTarget = await targeted.exec("id -u");
  const argv2 = withTarget.stdout.split("\n").filter(Boolean);
  const destination = argv2.indexOf("deploy@remote.example");

  assert.ok(hasPair(argv2, "-p", "2222"));
  assert.ok(hasPair(argv2, "-i", "/home/deploy/.ssh/id_ed25519"));
  assert.ok(hasPair(argv2, "-o", "ServerAliveInterval=15"), "extraOptions reach ssh");
  assert.ok(destination > pairIndex(argv2, "-p", "2222"));
  assert.ok(destination > pairIndex(argv2, "-i", "/home/deploy/.ssh/id_ed25519"));
  assert.ok(pairIndex(argv2, "-o", "ServerAliveInterval=15") < argv2.length - 1);
  assert.equal(argv2.at(-1), "id -u");

  transport.dispose();
  targeted.dispose();
});

test("execWithInput runs the script through `sh -s` with the body on stdin", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvAndStdin, "ssh-argv-and-stdin");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });
  const script = [
    "#!/bin/sh",
    "set -eu",
    "# SCRIPT-BODY-MARKER must never travel as an ssh argument",
    'echo "$PI_HOST_PAIRING_TOKEN"',
  ].join("\n");

  const result = await transport.execWithInput("sh -s", script);
  assert.equal(result.code, 0);

  const argvSection = result.stdout.slice(
    result.stdout.indexOf("ARGV-BEGIN"),
    result.stdout.indexOf("ARGV-END"),
  );
  assert.equal(argvSection.split("\n").filter(Boolean).at(-1), "sh -s");
  // The script is delivered on stdin, so it cannot land in argv (where it would
  // be visible in `ps` and could be re-split by the remote shell).
  assert.ok(!argvSection.includes("SCRIPT-BODY-MARKER"), "the script must not reach argv");
  assert.ok(!argvSection.includes("set -eu"));

  const stdinSection = result.stdout.slice(result.stdout.indexOf("ARGV-END"));
  assert.ok(
    stdinSection.includes("SCRIPT-BODY-MARKER"),
    `the script must reach stdin: ${result.stdout}`,
  );
  assert.ok(stdinSection.includes('echo "$PI_HOST_PAIRING_TOKEN"'));

  transport.dispose();
});

test("execWithInput runs the caller's command and keeps its input off argv", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvAndStdin, "ssh-argv-and-stdin");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });
  const command = 'node "$HOME/.pi-desktop/pi-host/current/pi-host.js" provider-import';

  const result = await transport.execWithInput(command, '{"secretValue":"KEY-MARKER"}');
  assert.equal(result.code, 0);

  const argvSection = result.stdout.slice(
    result.stdout.indexOf("ARGV-BEGIN"),
    result.stdout.indexOf("ARGV-END"),
  );
  assert.equal(argvSection.split("\n").filter(Boolean).at(-1), command);
  assert.ok(!argvSection.includes("KEY-MARKER"), "the payload must not reach argv");
  assert.ok(result.stdout.slice(result.stdout.indexOf("ARGV-END")).includes("KEY-MARKER"));

  transport.dispose();
});

test("a non-zero exit becomes a typed error carrying both streams", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.failing, "ssh-failing");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });

  await assert.rejects(
    () => transport.exec("bootstrap"),
    (error) => {
      assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
      assert.equal(error.code, 3);
      assert.equal(error.command, "bootstrap");
      assert.match(error.stderr, /STDERR-MARKER-connection reset by peer/);
      assert.match(error.stdout, /STDOUT-MARKER-the remote step failed/);
      assert.match(
        error.message,
        /exit code 3: STDERR-MARKER-connection reset by peer/,
        "the toast-facing message must carry ssh's last diagnostic",
      );
      return true;
    },
  );

  transport.dispose();
});

test("the stdout of that error is redacted of a live pairing token", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.tokenLeak, "ssh-token-leak");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });

  await assert.rejects(
    () => transport.exec("bootstrap"),
    (error) => {
      assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
      assert.equal(error.code, 7);
      assert.ok(
        error.stdout.includes("PI_HOST_PAIRING_TOKEN <redacted>"),
        `the token line must be redacted: ${error.stdout}`,
      );
      assert.ok(!error.stdout.includes("ppt1.secret"), "the token itself must be gone");
      // Redaction is targeted: the surrounding diagnostics survive.
      assert.ok(error.stdout.includes("bootstrap step 3 failed on the remote host"));
      return true;
    },
  );

  transport.dispose();
});

test("a command outliving timeoutMs is killed, not awaited", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.sleeper, "ssh-sleeper");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });

  const started = Date.now();
  await assert.rejects(
    () => transport.exec("sleep 30", { timeoutMs: 400 }),
    (error) => {
      assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
      assert.match(error.message, /timed out after 400 ms/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `the timeout must cut the command short, took ${elapsed} ms`);

  transport.dispose();
});

test("a binary that does not exist rejects instead of crashing", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvEcho, "ssh-argv-echo");
  const missing = join(dirname(binary), "ssh-that-is-not-installed");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary: missing });

  await assert.rejects(
    () => transport.exec("uname -s", { timeoutMs: 5_000 }),
    (error) => {
      assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
      assert.match(error.message, /could not be started/);
      return true;
    },
  );

  transport.dispose();
});

test("forward rejects fast, with the ssh diagnostic, when ssh exits instead", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.deadSsh, "ssh-dead");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });
  const localPort = await reserveLocalPort();

  const started = Date.now();
  await assert.rejects(
    () => transport.forward({ localPort, remoteHost: "127.0.0.1", remotePort: 1, timeoutMs: 30_000 }),
    (error) => {
      assert.equal(error.errorCode, "REMOTE_FORWARD_FAILED");
      // The half the dead-code path lost: ssh's own reason for giving up.
      assert.match(error.message, /Permission denied \(publickey\)/, error.message);
      assert.match(error.message, /code 255/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 5_000,
    `a dead ssh must reject immediately, but the forward took ${elapsed} ms (probe timeout is 30 s)`,
  );

  transport.dispose();
});

test("forward resolves once the port answers and close() is idempotent", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, NODE_FIXTURE, "ssh-forward");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });
  const localPort = await reserveLocalPort();

  const forward = await transport.forward({
    localPort,
    remoteHost: "127.0.0.1",
    remotePort: 41_234,
    timeoutMs: 10_000,
  });
  try {
    assert.equal(forward.localPort, localPort, "the forward reports the port that was claimed");
    const pid = await waitForPid(`${binary}.forward.pid`);
    assert.equal(await portAccepts(localPort), true);

    await forward.close();
    await forward.close();
    await waitFor(() => !processAlive(pid), "the forward's ssh process to be reaped");
    await waitFor(
      async () => !(await portAccepts(localPort)),
      "the forwarded port to stop accepting connections",
    );
  } finally {
    // dispose() reaps the child whatever path the assertions took.
    transport.dispose();
  }
});

test("dispose reaps a live forward and leaves a finished exec alone", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, NODE_FIXTURE, "ssh-dispose");
  const logged = [];
  const transport = createSystemSshTransport(
    { host: "remote.example" },
    { binary, log: (level, message, data) => logged.push({ level, message, data }) },
  );

  try {
    const exec = await transport.exec("uname -s");
    assert.equal(exec.code, 0, exec.stderr);
    const execPid = await waitForPid(`${binary}.exec.pid`);
    assert.equal(processAlive(execPid), false, "a completed exec has already exited");

    const localPort = await reserveLocalPort();
    await transport.forward({
      localPort,
      remoteHost: "127.0.0.1",
      remotePort: 41_234,
      timeoutMs: 10_000,
    });
    const forwardPid = await waitForPid(`${binary}.forward.pid`);
    assert.equal(processAlive(forwardPid), true);

    transport.dispose();

    // An open forward must not outlive the transport that owns it.
    await waitFor(() => !processAlive(forwardPid), "dispose to reap the forward's ssh process");
    assert.ok(
      logged.some(
        (entry) => entry.message === "ssh transport disposed" && entry.data?.host === "remote.example",
      ),
      `dispose must log through the injected logger: ${JSON.stringify(logged)}`,
    );
  } finally {
    transport.dispose();
  }
});

test("reserveLocalPort hands out a port it has already released", { timeout: TEST_TIMEOUT_MS }, async () => {
  const port = await reserveLocalPort();
  assert.ok(Number.isInteger(port) && port > 0, `expected a usable port, got ${port}`);

  // Binding it here only succeeds if the probe really closed its socket.
  const server = createServer();
  try {
    await new Promise((resolveBound, rejectBound) => {
      server.once("error", rejectBound);
      server.listen(port, "127.0.0.1", resolveBound);
    });
    assert.equal(await portAccepts(port), true);
  } finally {
    await new Promise((resolveClosed) => server.close(resolveClosed));
  }
});

test("assertSshArgument rejects option-shaped values and trims the rest", { timeout: TEST_TIMEOUT_MS }, () => {
  for (const value of ["", "   ", "-oProxyCommand=x", "\t-oFoo=bar"]) {
    assert.throws(
      () => assertSshArgument(value, "host"),
      (error) => {
        assert.equal(error.errorCode, "INVALID_ARGUMENT");
        assert.equal(error.field, "host");
        return true;
      },
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }

  assert.equal(assertSshArgument("  remote.example  ", "host"), "remote.example");
  assert.equal(assertSshArgument("deploy", "user"), "deploy");
});
