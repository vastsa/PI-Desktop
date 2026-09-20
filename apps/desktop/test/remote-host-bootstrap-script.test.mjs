import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { buildBootstrapScript, parseBootstrapOutput, shellQuote } = await import(
  "../electron/main/remote/pi-host-bootstrap-script.ts"
);

const VERSION = "0.15.1-beta.5";
const BUNDLE_DIR = `pi-host-${VERSION}-linux-x64`;
const ARTIFACT_NAME = `${BUNDLE_DIR}.tar.gz`;
const ARTIFACT_URL = `https://github.com/vastsa/PI-Desktop/releases/download/v${VERSION}/${ARTIFACT_NAME}`;
const DIGEST = "0123456789abcdef".repeat(4);
/** The sandbox the script's `HOME`/`PATH` point at, outside the real user's. */
const WORK_SUBDIR = ".pi-desktop/pi-host/.bootstrap";

/** Inputs every scenario starts from; callers override the digest or version. */
function scriptInput(overrides = {}) {
  return {
    version: VERSION,
    artifactUrl: ARTIFACT_URL,
    artifactName: ARTIFACT_NAME,
    bundleDir: BUNDLE_DIR,
    expectedSha256: DIGEST,
    port: 0,
    pairingLifetimeMs: 600_000,
    readyTimeoutSec: 30,
    ...overrides,
  };
}

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Everything the generated script touches, faked on `PATH`: a `curl` that
 * copies a prepared tarball, a `node` that plays the host's ready/pairing
 * output, and a `sha256sum` that hashes with the real Node. The tarball is a
 * real `tar.gz` because the script unpacks and installs it.
 *
 * Returns the env for the run plus the digest the script will compute, which
 * is what `expectedSha256` has to be for a run that is meant to succeed.
 */
async function prepareSandbox(root, { readyVersion = VERSION } = {}) {
  const stage = join(root, "stage");
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(join(stage, BUNDLE_DIR), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(stage, BUNDLE_DIR, "install.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const tarball = join(root, "artifact.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", stage, BUNDLE_DIR]);
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");

  // `sha256_of` prefers `sha256sum`; the stand-in delegates to the real Node so
  // the digest is computed the same way the release publishes it.
  const sha256Helper = join(root, "sha256.mjs");
  await writeFile(
    sha256Helper,
    [
      'import { createHash } from "node:crypto";',
      'import { readFileSync } from "node:fs";',
      "const file = process.argv[2];",
      'process.stdout.write(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${file}\\n`);',
      "",
    ].join("\n"),
  );
  await writeFile(join(bin, "sha256sum"), `#!/bin/sh\nexec "${process.execPath}" "${sha256Helper}" "$1"\n`, {
    mode: 0o755,
  });

  await writeFile(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      "# pretend the artifact URL served the tarball this test prepared",
      'out=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      '[ -n "$out" ] || { printf \'fake curl: missing -o\\n\' >&2; exit 2; }',
      'cp "$PI_HOST_TEST_TARBALL" "$out"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const readyLine = `PI_HOST_READY ${JSON.stringify({
    hostId: "host_x",
    host: "127.0.0.1",
    port: 41234,
    version: readyVersion,
  })}`;
  const pairingLine = `PI_HOST_PAIRING_TOKEN ${JSON.stringify({
    token: "ppt1.stub",
    expiresAt: 1_893_456_000_000,
  })}`;
  await writeFile(
    join(bin, "node"),
    [
      "#!/bin/sh",
      "# `node -p` is the script's version probe; answer with a modern major.",
      'case " $* " in',
      "  *\" -p \"*) printf '99\\n'; exit 0 ;;",
      "esac",
      `printf '%s\\n' '${readyLine}'`,
      `printf '%s\\n' '${pairingLine}'`,
      "# The script polls `kill -0` on this pid, so the fake host outlives the wait.",
      "sleep 5",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    digest,
    home,
    tarball,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_HOST_TEST_TARBALL: tarball,
    },
  };
}

function runScript(scriptPath, env) {
  return execFileSync("sh", [scriptPath], {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

test("shellQuote produces a single-quoted literal that cannot escape", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  // The one character a single-quoted string cannot contain ends the literal,
  // emits an escaped quote, and reopens it — the POSIX `'\''` dance.
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // Command substitution and variable expansion are inert inside quotes; a
  // caller-supplied URL must never execute.
  assert.equal(shellQuote("$(touch /tmp/pwned)"), "'$(touch /tmp/pwned)'");
});

test("buildBootstrapScript interpolates every input as a quoted literal", () => {
  const script = buildBootstrapScript(scriptInput());
  assert.ok(script.startsWith("#!/bin/sh\n"), "the script is uploaded and run by `sh`");
  assert.ok(script.includes(`VERSION='${VERSION}'`));
  assert.ok(script.includes(`ARTIFACT_URL='${ARTIFACT_URL}'`));
  assert.ok(script.includes(`ARTIFACT_NAME='${ARTIFACT_NAME}'`));
  assert.ok(script.includes(`BUNDLE_DIR='${BUNDLE_DIR}'`));
  assert.ok(script.includes(`EXPECTED_SHA256='${DIGEST}'`));
  assert.ok(script.includes("PORT='0'"));
  assert.ok(script.includes("PAIRING_LIFETIME_MS='600000'"));
  assert.ok(script.includes("READY_TIMEOUT_SEC='30'"));
  // The Node floor is injected from the module, not left as an empty shell var.
  assert.match(script, /^MIN_NODE_MAJOR='\d+'$/m);
  assert.ok(script.includes('$MIN_NODE_MAJOR'));

  // Every `${…}` that reaches the shell must be deliberate. `${HOME:-}` is a
  // shell expansion; anything else would be a JS placeholder that never
  // interpolated and would run as garbage on the remote machine.
  const interpolations = [...script.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]);
  assert.deepEqual(interpolations, ["HOME:-"]);
});

test("the generated script is valid POSIX shell, even with hostile inputs", async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-syntax-");
  try {
    const plain = join(dir, "plain.sh");
    await writeFile(plain, buildBootstrapScript(scriptInput()));
    execFileSync("sh", ["-n", plain]);

    // Quoting is the only thing standing between a caller-supplied host or
    // label and the remote shell, so the syntax check runs on those too.
    const hostile = join(dir, "hostile.sh");
    await writeFile(
      hostile,
      buildBootstrapScript(
        scriptInput({
          version: "1.0.0'; touch \"$HOME/pwned\"; echo '",
          artifactUrl: "https://example.invalid/a'b",
          artifactName: "a b'c.tar.gz",
          bundleDir: "d'est",
        }),
      ),
    );
    execFileSync("sh", ["-n", hostile]);
  } finally {
    await cleanup();
  }
});

test("a hostile version stays one literal value when the assignments run", async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-quote-");
  try {
    const hostileVersion = "1.0.0'; touch \"$HOME/pwned\"; echo '";
    const script = buildBootstrapScript(scriptInput({ version: hostileVersion }));
    const assignments = script.split("\n").filter((line) => /^[A-Z_]+='/.test(line));
    assert.ok(
      assignments.some((line) => line.startsWith("VERSION=")),
      "the assignment block must be visible to this test",
    );

    const echoed = execFileSync("sh", ["-c", `${assignments.join("\n")}\nprintf '%s' "$VERSION"`], {
      encoding: "utf8",
      env: { ...process.env, HOME: dir },
    });
    assert.equal(echoed, hostileVersion);
    assert.equal(existsSync(join(dir, "pwned")), false, "the injected command must not have run");
  } finally {
    await cleanup();
  }
});

test("the generated script installs, starts, and prints the ready/pairing lines", async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-run-");
  try {
    const sandbox = await prepareSandbox(dir);
    const scriptPath = join(dir, "bootstrap.sh");
    await writeFile(scriptPath, buildBootstrapScript(scriptInput({ expectedSha256: sandbox.digest })));

    const stdout = runScript(scriptPath, sandbox.env);
    const parsed = parseBootstrapOutput(stdout);
    assert.equal(parsed.failure, null);
    assert.deepEqual(parsed.ready, {
      hostId: "host_x",
      host: "127.0.0.1",
      port: 41234,
      version: VERSION,
    });
    assert.deepEqual(parsed.pairing, { token: "ppt1.stub", expiresAt: 1_893_456_000_000 });
    assert.deepEqual(parsed.steps, ["download", "verify", "install", "start", "await-ready", "ok"]);

    // The host was started under the sandbox HOME and left running there.
    const pid = (await readFile(join(sandbox.home, WORK_SUBDIR, "pi-host.pid"), "utf8")).trim();
    assert.match(pid, /^\d+$/);
  } finally {
    await cleanup();
  }
});

test("a checksum mismatch fails the script before anything is installed", async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-digest-");
  try {
    const sandbox = await prepareSandbox(dir);
    const scriptPath = join(dir, "bootstrap.sh");
    // A tampered download is the case the trust anchor exists for: the digest
    // travels over the same SSH channel as the script that checks it.
    await writeFile(scriptPath, buildBootstrapScript(scriptInput({ expectedSha256: "0".repeat(64) })));

    let failure;
    try {
      runScript(scriptPath, sandbox.env);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the script must exit non-zero");
    assert.notEqual(failure.status, 0);
    assert.match(String(failure.stderr), /PI_HOST_BOOTSTRAP_FAILED checksum-mismatch/);
    // The typed line is on stdout too, which is how the desktop reports the step.
    assert.match(String(failure.stdout), /PI_HOST_FAILED \{.*"step":"checksum-mismatch"/);
    assert.ok(!String(failure.stdout).includes("PI_HOST_READY"), "the host must not have been started");
  } finally {
    await cleanup();
  }
});

test("parseBootstrapOutput reads the ready and pairing lines", () => {
  const output = parseBootstrapOutput(
    [
      "PI_HOST_BOOTSTRAP download",
      'PI_HOST_READY {"hostId":"host_x","host":"127.0.0.1","port":41234,"version":"0.15.1-beta.5"}',
      'PI_HOST_PAIRING_TOKEN {"token":"ppt1.abc","expiresAt":123}',
      "PI_HOST_BOOTSTRAP ok",
    ].join("\n"),
  );
  assert.deepEqual(output.ready, {
    hostId: "host_x",
    host: "127.0.0.1",
    port: 41234,
    version: "0.15.1-beta.5",
  });
  assert.deepEqual(output.pairing, { token: "ppt1.abc", expiresAt: 123 });
  assert.deepEqual(output.steps, ["download", "ok"]);
  assert.equal(output.failure, null);
});

test("parseBootstrapOutput collects step lines and ignores interleaved noise", () => {
  const output = parseBootstrapOutput(
    [
      "Warning: Permanently added 'host' (ED25519) to the list of known hosts.",
      "PI_HOST_BOOTSTRAP download",
      "",
      "PI_HOST_BOOTSTRAP   verify  ",
      "some other chatter",
      "PI_HOST_BOOTSTRAP install",
    ].join("\n"),
  );
  assert.deepEqual(output.steps, ["download", "verify", "install"]);
  assert.equal(output.ready, null);
  assert.equal(output.pairing, null);
});

test("parseBootstrapOutput reports the failing step and ignores unrelated failures", () => {
  const timedOut = parseBootstrapOutput(
    ['PI_HOST_BOOTSTRAP await-ready', 'PI_HOST_FAILED {"code":"HOST_BOOTSTRAP_FAILED","step":"ready-timeout"}'].join(
      "\n",
    ),
  );
  assert.equal(timedOut.failure, "ready-timeout");

  // The script also writes its own bare failed-line; the first one wins.
  const mismatch = parseBootstrapOutput(
    ["PI_HOST_BOOTSTRAP_FAILED checksum-mismatch", "PI_HOST_BOOTSTRAP_FAILED download-failed"].join("\n"),
  );
  assert.equal(mismatch.failure, "checksum-mismatch");

  // A failure line for a different code, or malformed JSON, must not be read as
  // a bootstrap failure for this host.
  assert.equal(parseBootstrapOutput('PI_HOST_FAILED {"code":"OTHER","step":"x"}').failure, null);
  assert.equal(parseBootstrapOutput("PI_HOST_FAILED {not json").failure, null);
});

test("parseBootstrapOutput refuses a ready line with an unusable port", () => {
  const ready = (payload) => parseBootstrapOutput(`PI_HOST_READY ${JSON.stringify(payload)}`);
  const valid = { hostId: "host_x", host: "127.0.0.1", port: 41234, version: "0.15.1" };
  assert.equal(ready({ ...valid, port: 0 }).ready, null, "port 0 means the host never bound");
  assert.equal(ready({ ...valid, port: 41234.5 }).ready, null, "a fractional port is not a port");
  assert.equal(ready({ ...valid, port: "41234" }).ready, null, "a string port is not a port");
  assert.equal(ready({ ...valid, hostId: "" }).ready, null);
  assert.equal(parseBootstrapOutput("PI_HOST_READY {not json").ready, null);

  // The pairing line tolerates a missing expiry rather than dropping the token.
  const pairing = parseBootstrapOutput('PI_HOST_PAIRING_TOKEN {"token":"ppt1.abc"}');
  assert.deepEqual(pairing.pairing, { token: "ppt1.abc", expiresAt: 0 });
  assert.equal(parseBootstrapOutput('PI_HOST_PAIRING_TOKEN {"expiresAt":1}').pairing, null);
});
