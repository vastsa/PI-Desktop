import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const watchdogPath = join(repoRoot, "scripts", "macos-signing-watchdog.mjs");

/** 20s guard so a regression can never hang the suite. */
const WATCHDOG_GUARD_MS = 20_000;

/**
 * Run the watchdog and capture everything it printed. The environment is
 * neutralized first: a caller's PI_SIGNING_* / GITHUB_STEP_SUMMARY must not
 * change what the tests observe.
 */
function runWatchdog(args, { env = {}, cwd = repoRoot } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [watchdogPath, ...args], {
      cwd,
      env: {
        ...process.env,
        PI_SIGNING_TIMEOUT_SECONDS: "",
        PI_SIGNING_STALL_SECONDS: "",
        PI_SIGNING_HEARTBEAT_SECONDS: "",
        PI_CODESIGN_LOG: "",
        PI_CODESIGN_REAL: "",
        GITHUB_STEP_SUMMARY: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const guard = setTimeout(() => child.kill("SIGKILL"), WATCHDOG_GUARD_MS);
    child.on("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(guard);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

async function makeTempDir(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-signing-watchdog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function summaryLines(stdout) {
  return stdout.split("\n").filter((line) => line.startsWith("[sign] summary"));
}

/** The main summary line (the one carrying the counters). */
function summaryLine(stdout) {
  const line = summaryLines(stdout).find((entry) =>
    entry.includes("codesign-calls="),
  );
  assert.ok(line, `no [sign] summary line in:\n${stdout}`);
  return line;
}

function summaryNumber(stdout, name) {
  const match = summaryLine(stdout).match(new RegExp(`${name}=([0-9.]+)`));
  assert.ok(match, `no ${name}= in summary: ${summaryLine(stdout)}`);
  return Number(match[1]);
}

test("forwards child output with a [sign] prefix and reports a clean exit", async () => {
  const { status, stdout } = await runWatchdog([
    "--label",
    "clean",
    "--",
    "bash",
    "-c",
    'echo "Walking... /tmp/PI-Desktop.app/Contents"; echo "notice: nothing to see"; echo "Signing... /tmp/PI-Desktop.app/Contents/MacOS/PI-Desktop"',
  ]);

  assert.equal(status, 0);
  assert.match(stdout, /^\[sign\] /m);
  assert.ok(stdout.includes("[sign] notice: nothing to see"));
  assert.match(summaryLine(stdout), /label=clean /);
  assert.match(summaryLine(stdout), /exit=0 /);
});

test("passes a non-zero child exit code through to the caller", async () => {
  const { status, stdout } = await runWatchdog([
    "--label",
    "failing",
    "--",
    "bash",
    "-c",
    "exit 7",
  ]);

  assert.equal(status, 7);
  assert.match(summaryLine(stdout), /exit=7 /);
});

test("a silent signing stage produces a stall dump without failing the run", async () => {
  const { status, stdout, elapsedMs } = await runWatchdog([
    "--label",
    "stall",
    "--stall-seconds",
    "2",
    "--heartbeat-seconds",
    "1",
    "--timeout-seconds",
    "30",
    "--",
    "bash",
    "-c",
    'echo "Signing... /tmp/x/Electron Framework"; sleep 6',
  ]);

  assert.equal(status, 0, "a stall must not fail the run");
  assert.match(stdout, /\[sign\] STALL: no output for \d+s/);
  assert.match(stdout, /last file: \/tmp\/x\/Electron Framework/);
  assert.match(stdout, /\[sign\] STALL: recent output:/);
  assert.ok(elapsedMs < 20_000, `watchdog took ${elapsedMs}ms`);
});

test("a hard timeout kills the process group, dumps diagnostics and exits 124", async () => {
  const { status, stdout, elapsedMs } = await runWatchdog([
    "--label",
    "timeout",
    "--timeout-seconds",
    "2",
    "--stall-seconds",
    "60",
    "--heartbeat-seconds",
    "60",
    "--",
    "bash",
    "-c",
    'echo "Signing... /tmp/x/Foo"; sleep 30',
  ]);

  assert.equal(status, 124);
  assert.match(stdout, /\[sign\] TIMEOUT after 2s/);
  assert.match(stdout, /last file: \/tmp\/x\/Foo/);
  assert.match(stdout, /\[sign\] STALL: recent output:/);
  assert.match(stdout, /\[sign\] STALL: processes:/);
  assert.match(stdout, /\[sign\] STALL: codesign log tail:/);
  assert.match(summaryLine(stdout), /exit=124 /);
  assert.ok(elapsedMs < 10_000, `timeout took ${elapsedMs}ms`);
});

test("redacts a short certificate password even below the length guard", async () => {
  // The certificate password is the one value builder-util itself may print
  // unredacted, so it must be redacted at any length.
  const shortPassword = "pw12";
  const { status, stdout } = await runWatchdog(
    [
      "--label",
      "short-secret",
      "--",
      "bash",
      "-c",
      'echo "set-key-partition-list -s -k $CSC_KEY_PASSWORD /tmp/x.keychain"',
    ],
    { env: { CSC_KEY_PASSWORD: shortPassword } },
  );

  assert.equal(status, 0);
  assert.ok(
    !stdout.includes(shortPassword),
    `a short certificate password leaked: ${stdout}`,
  );
  assert.match(stdout, /\[redacted\]/);
});

test("redacts secrets printed by the child and by codesign-style arguments", async () => {
  const cscKeyPassword = "sentinel-csc-key-password-abcdef";
  const appSpecificPassword = "sentinel-apple-app-password-abcdef";
  const cscLink = "sentinel-csc-link-abcdef";
  const appleId = "sentinel-apple-id@example.com";
  const argumentPassword = "sentinel-argument-password";

  const { status, stdout, stderr } = await runWatchdog(
    [
      "--label",
      "redaction",
      "--",
      "bash",
      "-c",
      'echo "CSC_KEY_PASSWORD=$CSC_KEY_PASSWORD"; echo "APPLE_APP_SPECIFIC_PASSWORD=$APPLE_APP_SPECIFIC_PASSWORD"; echo "CSC_LINK=$CSC_LINK"; echo "APPLE_ID=$APPLE_ID"; echo "codesign --password sentinel-argument-password --keychain-password sentinel-keychain-password /tmp/whatever"; echo "executing file=/usr/bin/security args=set-key-partition-list -S apple-tool:,apple: -s -k sentinel-keychain-flag-password /tmp/x.keychain"; echo "stderr $CSC_KEY_PASSWORD" >&2',
    ],
    {
      env: {
        CSC_KEY_PASSWORD: cscKeyPassword,
        APPLE_APP_SPECIFIC_PASSWORD: appSpecificPassword,
        CSC_LINK: cscLink,
        APPLE_ID: appleId,
      },
    },
  );

  assert.equal(status, 0);
  const combined = `${stdout}${stderr}`;
  for (const secret of [
    cscKeyPassword,
    appSpecificPassword,
    cscLink,
    appleId,
    argumentPassword,
    "sentinel-keychain-password",
    // `security set-key-partition-list -k <p12 password>` is how
    // electron-builder unlocks the imported certificate, and `-k` is absent
    // from builder-util's own sensitive-stem list.
    "sentinel-keychain-flag-password",
  ]) {
    assert.ok(
      !combined.includes(secret),
      `secret leaked into the watchdog output: ${secret}`,
    );
  }
  assert.ok(combined.includes("[redacted]"));
  assert.match(combined, /--password \[redacted\]/);
  assert.match(combined, /-k \[redacted\]/);
  assert.match(stderr, /^\[sign\] stderr \[redacted\]$/m);
});

test(
  "the injected codesign shim times calls and the summary classifies them",
  { skip: process.platform !== "darwin" ? "the codesign shim is macOS-only" : false },
  async (t) => {
  const root = await makeTempDir(t);
  const fakeBin = join(root, "fakebin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, "codesign"),
    '#!/bin/bash\nsleep 0.3\nexit 0\n',
  );
  await chmod(join(fakeBin, "codesign"), 0o755);
  const codesignLog = join(root, "codesign-timing.log");

  const { status, stdout } = await runWatchdog(
    [
      "--label",
      "shim",
      "--codesign-log",
      codesignLog,
      "--",
      "bash",
      "-c",
      "codesign --display --verify /tmp/whatever",
    ],
    { env: { PATH: `${fakeBin}:${process.env.PATH}` } },
  );

  assert.equal(status, 0, stdout);
  const records = (await readFile(codesignLog, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
  assert.equal(records.length, 2, `expected one start/end pair: ${records}`);
  const [start, end] = records;
  assert.equal(start[0], "start");
  assert.equal(end[0], "end");
  assert.equal(start[2], end[2], "start and end must share the shim pid");
  assert.equal(start[3], "--display --verify /tmp/whatever");
  assert.equal(end[3], "0");
  assert.ok(Number(end[1]) >= Number(start[1]));

  assert.equal(summaryNumber(stdout, "codesign-calls"), 1);
  const categories = summaryLines(stdout).find((line) =>
    line.includes("codesign-categories"),
  );
  assert.ok(categories, `no categories line in:\n${stdout}`);
  assert.match(categories, /verify=1\/[0-9]+\.[0-9]s/);
    assert.ok(summaryNumber(stdout, "p50") > 0, summaryLine(stdout));
    assert.ok(summaryNumber(stdout, "max") > 0, summaryLine(stdout));
    assert.match(stdout, /\[sign\] summary slowest: \/tmp\/whatever /);
  },
);

test(
  "a failing codesign call is reported as a failure, not as a silent retry",
  { skip: process.platform !== "darwin" ? "the codesign shim is macOS-only" : false },
  async (t) => {
    const root = await makeTempDir(t);
    const fakeBin = join(root, "fakebin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "codesign"), "#!/bin/bash\nexit 70\n");
    await chmod(join(fakeBin, "codesign"), 0o755);

    const { status, stdout } = await runWatchdog(
      [
        "--label",
        "failing-codesign",
        "--codesign-log",
        join(root, "codesign-timing.log"),
        "--",
        "bash",
        "-c",
        "codesign --force --sign identity /tmp/failing-target || true",
      ],
      { env: { PATH: `${fakeBin}:${process.env.PATH}` } },
    );

    assert.equal(status, 0, stdout);
    // electron-builder retries a failing pass up to three times without saying
    // so; the failure count is the only signal that it happened.
    assert.match(
      stdout,
      /\[sign\] summary failures: 1 codesign calls exited non-zero/,
    );
  },
);

test("--no-codesign-shim runs the command untouched and reports zero calls", async (t) => {
  const root = await makeTempDir(t);
  const codesignLog = join(root, "unused-codesign-timing.log");

  const { status, stdout } = await runWatchdog([
    "--label",
    "no-shim",
    "--no-codesign-shim",
    "--codesign-log",
    codesignLog,
    "--",
    "bash",
    "-c",
    'echo "PI_CODESIGN_LOG=${PI_CODESIGN_LOG:-unset}"; echo "PI_CODESIGN_REAL=${PI_CODESIGN_REAL:-unset}"',
  ]);

  assert.equal(status, 0);
  assert.match(stdout, /codesign-shim=off/);
  assert.ok(stdout.includes("PI_CODESIGN_LOG=unset"));
  assert.ok(stdout.includes("PI_CODESIGN_REAL=unset"));
  assert.equal(summaryNumber(stdout, "codesign-calls"), 0);
  await assert.rejects(readFile(codesignLog, "utf8"));
});

test("a missing -- separator is a usage error", async () => {
  const withoutSeparator = await runWatchdog(["echo", "hi"]);
  assert.equal(withoutSeparator.status, 2);
  assert.match(withoutSeparator.stderr, /Usage: node scripts\/macos-signing-watchdog\.mjs/);
  assert.ok(withoutSeparator.stderr.includes("-- <command>"));

  const withoutCommand = await runWatchdog([]);
  assert.equal(withoutCommand.status, 2);
  assert.match(withoutCommand.stderr, /Usage: node scripts\/macos-signing-watchdog\.mjs/);
});

test("appends a markdown summary to GITHUB_STEP_SUMMARY", async (t) => {
  const root = await makeTempDir(t);
  const stepSummary = join(root, "step-summary.md");

  const { status } = await runWatchdog(
    ["--label", "gh-summary", "--", "bash", "-c", "echo building"],
    { env: { GITHUB_STEP_SUMMARY: stepSummary } },
  );

  assert.equal(status, 0);
  const markdown = await readFile(stepSummary, "utf8");
  assert.ok(markdown.includes("gh-summary"), markdown);
  assert.match(markdown, /\| elapsed \| [0-9]+\.[0-9]s \|/);
});

test("recognizes signing phases from the builder output in order", async () => {
  const script = [
    'console.log("Walking... /tmp/PI-Desktop.app/Contents");',
    'console.log("Signing... /tmp/PI-Desktop.app/Contents/MacOS/PI-Desktop");',
    'console.log("notarizing using notarytool");',
  ].join("\n");

  const { status, stdout } = await runWatchdog([
    "--label",
    "phases",
    "--",
    process.execPath,
    "-e",
    script,
  ]);

  assert.equal(status, 0, stdout);
  const phases = stdout
    .split("\n")
    .filter((line) => line.startsWith("[sign] phase:"))
    .map((line) => line.slice("[sign] phase: ".length));
  assert.deepEqual(phases, ["walking", "signing:PI-Desktop", "notarizing"]);
});
