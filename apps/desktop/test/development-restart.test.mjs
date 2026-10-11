import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runDevelopmentProcess } from "../../../scripts/dev-electron-restart.mjs";

const helperPath = fileURLToPath(
  new URL("../../../scripts/dev-electron-restart.mjs", import.meta.url),
);
const helperHref = pathToFileURL(helperPath).href;
const posix = process.platform !== "win32";
const PROCESS_GUARD_MS = 20_000;

const VITE_FIXTURE = `\
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const work = process.env.PI_TEST_WORK;
if (!work) throw new Error("PI_TEST_WORK is required");

const generationsPath = join(work, "generations.json");
const generations = existsSync(generationsPath)
  ? JSON.parse(readFileSync(generationsPath, "utf8"))
  : [];
const plan = JSON.parse(readFileSync(join(work, "plan.json"), "utf8"));
const step = plan[generations.length] ?? { action: "exit", code: 1 };
if (process.env.PI_TEST_CLI_MODE === "1") {
  // electron-vite replaces the inherited value, including when its tail is empty.
  const separator = process.argv.indexOf("--");
  process.env.ELECTRON_CLI_ARGS = JSON.stringify(
    separator === -1 ? [] : process.argv.slice(separator + 1),
  );
}

generations.push({
  index: generations.length,
  pid: process.pid,
  argv: process.argv.slice(1),
  cwd: process.cwd(),
  env: {
    PI_DESKTOP_DEV_RESTART_FILE: process.env.PI_DESKTOP_DEV_RESTART_FILE ?? null,
    PI_DESKTOP_DATA_DIR: process.env.PI_DESKTOP_DATA_DIR ?? null,
    ELECTRON_ENTRY: process.env.ELECTRON_ENTRY ?? null,
    ELECTRON_CLI_ARGS: process.env.ELECTRON_CLI_ARGS ?? null,
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL ?? null,
    REMOTE_DEBUGGING_PORT: process.env.REMOTE_DEBUGGING_PORT ?? null,
    V8_INSPECTOR_PORT: process.env.V8_INSPECTOR_PORT ?? null,
    V8_INSPECTOR_BRK_PORT: process.env.V8_INSPECTOR_BRK_PORT ?? null,
  },
});
writeFileSync(generationsPath, \`\${JSON.stringify(generations, null, 2)}\\n\`);

if (step.action === "restart" || step.action === "request-then-hang") {
  const file = process.env.PI_DESKTOP_DEV_RESTART_FILE;
  if (!file) throw new Error("PI_DESKTOP_DEV_RESTART_FILE missing");
  const payload = step.raw ?? JSON.stringify(step.request);
  writeFileSync(file, payload);
}

if (step.spawnGrandchild) {
  const alive = process.env.PI_TEST_GRANDCHILD_ALIVE;
  const child = spawn(process.execPath, [join(work, "electron-child.mjs")], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: process.env,
  });
  writeFileSync(join(work, "grandchild.pid"), String(child.pid));
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("grandchild exited before readiness")));
  });
}

writeFileSync(join(work, \`ready.\${generations.length}\`), String(process.pid));

if (step.action === "hang" || step.action === "request-then-hang") {
  setInterval(() => {}, 1 << 30);
} else if (step.signal) {
  process.kill(process.pid, step.signal);
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(step.code ?? 0);
}
`;

const ELECTRON_STANDIN = `\
#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PI_TEST_STALE_MARKER, "electron-relaunched");
process.exit(0);
`;

const ELECTRON_CHILD = `\
import { unlinkSync, writeFileSync } from "node:fs";
const alive = process.env.PI_TEST_GRANDCHILD_ALIVE;
writeFileSync(alive, String(process.pid));
const die = () => {
  try { unlinkSync(alive); } catch {}
  process.exit(0);
};
process.on("SIGINT", die);
process.on("SIGTERM", die);
setInterval(() => {}, 1 << 30);
process.send("ready");
`;

const SUPERVISE_SOURCE = `\
import { runDevelopmentProcess } from ${JSON.stringify(helperHref)};

try {
  const code = await runDevelopmentProcess(
    process.execPath,
    process.argv.slice(2),
    { cwd: process.cwd(), env: process.env },
  );
  process.exit(code ?? 0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function parseOwnedPid(value) {
  const raw =
    typeof value === "number" && Number.isInteger(value)
      ? String(value)
      : String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const pid = Number(raw);
  if (pid <= 1 || pid === process.pid || pid === process.ppid) return null;
  return pid;
}

function killOwnedPid(pid) {
  const owned = parseOwnedPid(pid);
  if (owned === null) return;
  try {
    process.kill(owned, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function killOwnedProcessGroup(pid) {
  if (!posix) return;
  const owned = parseOwnedPid(pid);
  if (owned === null) return;
  try {
    process.kill(-owned, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function pidFromFile(path) {
  if (!existsSync(path)) return null;
  try {
    return parseOwnedPid(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function cleanupOwnedDescendants(work) {
  killOwnedPid(pidFromFile(join(work, "grandchild.pid")));
}

function guardOwnedDescendants(t, work) {
  t.after(() => cleanupOwnedDescendants(work));
}

async function assertGrandchildGone(work) {
  const pid = pidFromFile(join(work, "grandchild.pid"));
  assert.ok(pid, "grandchild pid was not recorded");
  assert.equal(
    await waitUntilDead(pid),
    true,
    "owned descendant survived the development process leader",
  );
  assert.equal(existsSync(join(work, "grandchild.alive")), false);
}

function waitForPath(path, timeoutMs = PROCESS_GUARD_MS) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for ${path}`)),
      timeoutMs,
    );
    let watcher;
    try {
      watcher = watch(dirname(path), () => {
        if (existsSync(path)) finish();
      });
    } catch (error) {
      finish(error);
      return;
    }
    watcher.on("error", finish);
    if (existsSync(path)) finish();
  });
}

function waitForClose(child, timeoutMs = PROCESS_GUARD_MS) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for supervisor exit"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitUntilDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

async function readGenerations(work) {
  return JSON.parse(await readFile(join(work, "generations.json"), "utf8"));
}

function assertPrivateRestartFile(generation, work, dummyPath) {
  const restartFile = generation.env.PI_DESKTOP_DEV_RESTART_FILE;
  assert.equal(typeof restartFile, "string");
  assert.ok(restartFile.length > 0);
  assert.notEqual(restartFile, dummyPath);
  const fromWork = relative(work, restartFile);
  assert.ok(
    fromWork.startsWith("..") || isAbsolute(fromWork),
    `restart file must not live in the app cwd: ${restartFile}`,
  );
}

function assertRestartArtifactsGone(generation) {
  const restartFile = generation.env.PI_DESKTOP_DEV_RESTART_FILE;
  assert.equal(existsSync(restartFile), false);
  assert.equal(existsSync(dirname(restartFile)), false);
}

async function setupWork(t, { plan, env: extra = {} } = {}) {
  const work = await realpath(await mkdtemp(join(tmpdir(), "pi-desktop-dev-restart-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fixture = join(work, "vite-standin.mjs");
  const electronStandin = join(work, "electron-standin.mjs");
  const staleMarker = join(work, "stale-electron");
  const grandchildAlive = join(work, "grandchild.alive");
  const dummyRestartFile = join(work, "caller-restart.json");
  await writeFile(fixture, VITE_FIXTURE);
  await writeFile(electronStandin, ELECTRON_STANDIN);
  await chmod(electronStandin, 0o755);
  await writeFile(join(work, "electron-child.mjs"), ELECTRON_CHILD);
  await writeFile(dummyRestartFile, "[]");
  if (plan) {
    const steps = typeof plan === "function" ? plan({ electronStandin }) : plan;
    await writeFile(join(work, "plan.json"), `${JSON.stringify(steps)}\n`);
  }
  const env = {
    ...process.env,
    PI_TEST_WORK: work,
    PI_TEST_STALE_MARKER: staleMarker,
    PI_DESKTOP_DEV_RESTART_FILE: dummyRestartFile,
    PI_TEST_GRANDCHILD_ALIVE: grandchildAlive,
    ...extra,
  };
  for (const key of [
    "ELECTRON_ENTRY",
    "ELECTRON_CLI_ARGS",
    "ELECTRON_RENDERER_URL",
    "REMOTE_DEBUGGING_PORT",
    "V8_INSPECTOR_PORT",
    "V8_INSPECTOR_BRK_PORT",
  ]) {
    if (!(key in extra)) delete env[key];
  }
  return {
    work,
    fixture,
    electronStandin,
    staleMarker,
    grandchildAlive,
    dummyRestartFile,
    env,
  };
}

function parseCliArgs(value) {
  assert.equal(typeof value, "string");
  return JSON.parse(value);
}

test(
  "ordinary success does not restart the development process",
  { timeout: PROCESS_GUARD_MS },
  async (t) => {
    const { work, fixture, env, dummyRestartFile } = await setupWork(t, {
      plan: [{ action: "exit", code: 0 }],
    });
    const code = await runDevelopmentProcess(process.execPath, [fixture, "dev"], {
      cwd: work,
      env,
    });
    const generations = await readGenerations(work);
    assert.equal(code, 0);
    assert.equal(generations.length, 1);
    assert.deepEqual(generations[0].argv, [fixture, "dev"]);
    assert.equal(generations[0].cwd, work);
    assertPrivateRestartFile(generations[0], work, dummyRestartFile);
    assertRestartArtifactsGone(generations[0]);
  },
);

test(
  "ordinary error does not restart the development process",
  { timeout: PROCESS_GUARD_MS },
  async (t) => {
    const { work, fixture, env } = await setupWork(t, {
      plan: [{ action: "exit", code: 7 }],
    });
    const code = await runDevelopmentProcess(process.execPath, [fixture], {
      cwd: work,
      env,
    });
    const generations = await readGenerations(work);
    assert.equal(code, 7);
    assert.equal(generations.length, 1);
    assertRestartArtifactsGone(generations[0]);
  },
);

test(
  "a restart request respawns the same development process with entry, args, and data directory",
  { timeout: PROCESS_GUARD_MS },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-data-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const { work, fixture, electronStandin, staleMarker, env, dummyRestartFile } =
      await setupWork(t, {
        plan: ({ electronStandin }) => [
          {
            action: "restart",
            request: [
              electronStandin,
              "--user-data-dir=/tmp/pi-user-data",
              "--remote-debugging-port=9222",
              "--pi-managed-storage",
            ],
            code: 0,
          },
          { action: "exit", code: 0 },
        ],
        env: {
          PI_TEST_CLI_MODE: "1",
          PI_DESKTOP_DATA_DIR: dataDir,
          ELECTRON_RENDERER_URL: "http://127.0.0.1:1/stale-renderer",
          REMOTE_DEBUGGING_PORT: "9222",
          V8_INSPECTOR_PORT: "5858",
          V8_INSPECTOR_BRK_PORT: "5859",
        },
      });

    const code = await runDevelopmentProcess(
      process.execPath,
      [fixture, "dev"],
      { cwd: work, env, restartArgs: [fixture, "dev"] },
    );
    const generations = await readGenerations(work);

    assert.equal(code, 0);
    assert.equal(generations.length, 2);
    assert.notEqual(generations[0].pid, generations[1].pid);
    assert.deepEqual(generations[0].argv, [fixture, "dev"]);
    // Native app.relaunch would exec this Electron entry against a dead Vite origin.
    assert.equal(existsSync(staleMarker), false);

    assert.equal(generations[0].env.PI_DESKTOP_DATA_DIR, dataDir);
    assert.equal(generations[0].env.ELECTRON_RENDERER_URL, "http://127.0.0.1:1/stale-renderer");
    assert.equal(generations[0].env.REMOTE_DEBUGGING_PORT, "9222");
    assert.equal(generations[0].env.V8_INSPECTOR_PORT, "5858");
    assert.equal(generations[0].env.V8_INSPECTOR_BRK_PORT, "5859");
    assert.equal(generations[0].env.ELECTRON_ENTRY, null);

    assert.equal(generations[1].env.PI_DESKTOP_DATA_DIR, dataDir);
    assert.equal(generations[1].env.ELECTRON_ENTRY, electronStandin);
    assert.deepEqual(parseCliArgs(generations[1].env.ELECTRON_CLI_ARGS), [
      "--user-data-dir=/tmp/pi-user-data",
      "--remote-debugging-port=9222",
      "--pi-managed-storage",
    ]);
    assert.equal(generations[1].env.ELECTRON_RENDERER_URL, null);
    assert.equal(generations[1].env.REMOTE_DEBUGGING_PORT, null);
    assert.equal(generations[1].env.V8_INSPECTOR_PORT, null);
    assert.equal(generations[1].env.V8_INSPECTOR_BRK_PORT, null);
    assert.equal(generations[1].cwd, work);
    assert.equal(
      generations[0].env.PI_DESKTOP_DEV_RESTART_FILE,
      generations[1].env.PI_DESKTOP_DEV_RESTART_FILE,
    );
    assertPrivateRestartFile(generations[0], work, dummyRestartFile);
    assert.equal(existsSync(dummyRestartFile), true);
    assertRestartArtifactsGone(generations[0]);
  },
);

test(
  "each explicit restart request starts another development process",
  { timeout: PROCESS_GUARD_MS },
  async (t) => {
    const { work, fixture, electronStandin, env } = await setupWork(t, {
      plan: ({ electronStandin }) => [
        { action: "restart", request: [electronStandin, "--first"], code: 0 },
        { action: "restart", request: [electronStandin, "--second"], code: 0 },
        { action: "exit", code: 4 },
      ],
    });
    const code = await runDevelopmentProcess(process.execPath, [fixture], {
      cwd: work,
      env,
    });
    const generations = await readGenerations(work);
    assert.equal(code, 4);
    assert.equal(generations.length, 3);
    assert.deepEqual(parseCliArgs(generations[1].env.ELECTRON_CLI_ARGS), ["--first"]);
    assert.deepEqual(parseCliArgs(generations[2].env.ELECTRON_CLI_ARGS), ["--second"]);
    assertRestartArtifactsGone(generations[0]);
  },
);

test(
  "an invalid restart request is an error and does not respawn",
  { timeout: PROCESS_GUARD_MS },
  async (t) => {
    const empty = await setupWork(t, {
      plan: [{ action: "restart", request: [], code: 0 }],
    });
    await assert.rejects(() =>
      runDevelopmentProcess(process.execPath, [empty.fixture], {
        cwd: empty.work,
        env: empty.env,
      }),
    );
    assert.equal((await readGenerations(empty.work)).length, 1);
    assert.equal(existsSync(empty.staleMarker), false);
    assertRestartArtifactsGone((await readGenerations(empty.work))[0]);

    const malformed = await setupWork(t, {
      plan: [{ action: "restart", raw: "{", code: 0 }],
    });
    await assert.rejects(() =>
      runDevelopmentProcess(process.execPath, [malformed.fixture], {
        cwd: malformed.work,
        env: malformed.env,
      }),
    );
    assert.equal((await readGenerations(malformed.work)).length, 1);
    assertRestartArtifactsGone((await readGenerations(malformed.work))[0]);
  },
);

test(
  "a missing executable surfaces the spawn error",
  { timeout: PROCESS_GUARD_MS },
  async (t) => {
    const { work, env } = await setupWork(t);
    const missing = join(work, "no-such-development-process");
    await assert.rejects(
      () => runDevelopmentProcess(missing, ["dev"], { cwd: work, env }),
      (error) => {
        assert.equal(error.code, "ENOENT");
        return true;
      },
    );
    assert.equal(existsSync(join(work, "generations.json")), false);
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  const status = 128 + osConstants.signals[signal];
  test(
    `${signal} stops the owned process tree and ignores a pending restart`,
    {
      skip: posix ? false : "POSIX process-group signal ownership",
      timeout: PROCESS_GUARD_MS,
    },
    async (t) => {
      const { work, fixture, electronStandin, staleMarker, grandchildAlive, env } =
        await setupWork(t, {
          plan: ({ electronStandin }) => [
            {
              action: "request-then-hang",
              request: [electronStandin, "--after-signal"],
              spawnGrandchild: true,
            },
            { action: "exit", code: 0 },
          ],
        });
      await writeFile(join(work, "supervise.mjs"), SUPERVISE_SOURCE);

      const supervisor = spawn(
        process.execPath,
        [join(work, "supervise.mjs"), fixture, "dev"],
        {
          cwd: work,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      let stderr = "";
      supervisor.stdout.resume();
      supervisor.stderr.setEncoding("utf8");
      supervisor.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      let childPid;
      let grandchildPid;
      t.after(() => {
        if (supervisor.exitCode === null && supervisor.signalCode === null) {
          killOwnedProcessGroup(supervisor.pid);
          if (parseOwnedPid(supervisor.pid) !== null) supervisor.kill("SIGKILL");
        }
        killOwnedPid(childPid);
        killOwnedPid(grandchildPid);
        cleanupOwnedDescendants(work);
      });

      await waitForPath(join(work, "ready.1"));
      childPid = parseOwnedPid(await readFile(join(work, "ready.1"), "utf8"));
      grandchildPid = parseOwnedPid(await readFile(join(work, "grandchild.pid"), "utf8"));
      assert.ok(childPid);
      assert.ok(grandchildPid);
      assert.equal(isAlive(childPid), true);
      assert.equal(isAlive(grandchildPid), true);
      assert.equal(existsSync(grandchildAlive), true);

      process.kill(supervisor.pid, signal);
      const completion = await waitForClose(supervisor);
      assert.equal(
        completion.code,
        status,
        `expected ${status} from ${signal}, got code=${completion.code} signal=${completion.signal}\n${stderr}`,
      );
      assert.equal(await waitUntilDead(childPid), true, "owned development process still running");
      assert.equal(
        await waitUntilDead(grandchildPid),
        true,
        "Electron grandchild survived signal shutdown",
      );
      assert.equal(existsSync(join(work, "ready.2")), false);
      assert.equal(existsSync(staleMarker), false);
      const generations = await readGenerations(work);
      assert.equal(generations.length, 1, stderr);
      assertRestartArtifactsGone(generations[0]);
    },
  );
}

test(
  "a pending restart request does not override a failed child exit",
  { timeout: PROCESS_GUARD_MS },
  async (t) => {
    const nonzero = await setupWork(t, {
      plan: ({ electronStandin }) => [
        {
          action: "restart",
          request: [electronStandin, "--should-not-run"],
          code: 9,
        },
        { action: "exit", code: 0 },
      ],
    });
    const code = await runDevelopmentProcess(process.execPath, [nonzero.fixture], {
      cwd: nonzero.work,
      env: nonzero.env,
    });
    assert.equal(code, 9);
    assert.equal((await readGenerations(nonzero.work)).length, 1);
    assert.equal(existsSync(nonzero.staleMarker), false);
    assertRestartArtifactsGone((await readGenerations(nonzero.work))[0]);

    const malformed = await setupWork(t, {
      plan: [{ action: "restart", raw: "{", code: 3 }],
    });
    const malformedCode = await runDevelopmentProcess(
      process.execPath,
      [malformed.fixture],
      { cwd: malformed.work, env: malformed.env },
    );
    assert.equal(malformedCode, 3);
    assert.equal((await readGenerations(malformed.work)).length, 1);
    assertRestartArtifactsGone((await readGenerations(malformed.work))[0]);
  },
);

test(
  "a pending restart request does not override a signal exit",
  {
    skip: posix ? false : "POSIX process-group signal ownership",
    timeout: PROCESS_GUARD_MS,
  },
  async (t) => {
    const { work, fixture, electronStandin, staleMarker, env } = await setupWork(t, {
      plan: ({ electronStandin }) => [
        {
          action: "restart",
          request: [electronStandin, "--should-not-run"],
          signal: "SIGTERM",
          spawnGrandchild: true,
        },
        { action: "exit", code: 0 },
      ],
    });
    guardOwnedDescendants(t, work);
    const code = await runDevelopmentProcess(process.execPath, [fixture], {
      cwd: work,
      env,
    });
    const generations = await readGenerations(work);
    assert.equal(code, 128 + osConstants.signals.SIGTERM);
    assert.equal(generations.length, 1);
    assert.equal(existsSync(staleMarker), false);
    await assertGrandchildGone(work);
    assertRestartArtifactsGone(generations[0]);
  },
);

for (const [name, plan, expected] of [
  [
    "a failed development process leader",
    [{ action: "exit", code: 7, spawnGrandchild: true }],
    7,
  ],
  [
    "an ordinary successful development process",
    [{ action: "exit", code: 0, spawnGrandchild: true }],
    0,
  ],
]) {
  test(
    `owned descendants do not survive ${name}`,
    {
      skip: posix ? false : "POSIX process-group signal ownership",
      timeout: PROCESS_GUARD_MS,
    },
    async (t) => {
      const { work, fixture, env } = await setupWork(t, { plan });
      guardOwnedDescendants(t, work);
      const code = await runDevelopmentProcess(process.execPath, [fixture], {
        cwd: work,
        env,
      });
      const generations = await readGenerations(work);
      assert.equal(code, expected);
      assert.equal(generations.length, 1);
      await assertGrandchildGone(work);
      assertRestartArtifactsGone(generations[0]);
    },
  );
}

test(
  "owned descendants do not survive a successful development restart",
  {
    skip: posix ? false : "POSIX process-group signal ownership",
    timeout: PROCESS_GUARD_MS,
  },
  async (t) => {
    const { work, fixture, env } = await setupWork(t, {
      plan: ({ electronStandin }) => [
        {
          action: "restart",
          request: [electronStandin, "--after-restart"],
          code: 0,
          spawnGrandchild: true,
        },
        { action: "exit", code: 0 },
      ],
    });
    guardOwnedDescendants(t, work);
    const code = await runDevelopmentProcess(process.execPath, [fixture], {
      cwd: work,
      env,
    });
    const generations = await readGenerations(work);
    assert.equal(code, 0);
    assert.equal(generations.length, 2);
    await assertGrandchildGone(work);
    assertRestartArtifactsGone(generations[0]);
  },
);

test("macOS empty-group EPERM does not prevent an explicit successful restart", {
  skip: process.platform !== "darwin", timeout: PROCESS_GUARD_MS,
}, async (t) => {
  const { work, fixture, env } = await setupWork(t, {
    plan: ({ electronStandin }) => [
      { action: "restart", request: [electronStandin], code: 0 },
      { action: "exit", code: 0 },
    ],
  });
  const kill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid < 0 && signal === "SIGTERM") {
      throw Object.assign(new Error("Empty process group"), { code: "EPERM" });
    }
    return kill.call(process, pid, signal);
  });
  assert.equal(await runDevelopmentProcess(process.execPath, [fixture], { cwd: work, env }), 0);
  assert.equal((await readGenerations(work)).length, 2);
  assertRestartArtifactsGone((await readGenerations(work))[0]);
});

test("macOS cleanup permission errors remain visible while owned descendants are alive", {
  skip: process.platform !== "darwin", timeout: PROCESS_GUARD_MS,
}, async (t) => {
  const { work, fixture, env } = await setupWork(t, {
    plan: [{ action: "exit", code: 0, spawnGrandchild: true }],
  });
  guardOwnedDescendants(t, work);
  const kill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid < 0 && signal === "SIGTERM") {
      throw Object.assign(new Error("Denied live process group"), { code: "EPERM" });
    }
    return kill.call(process, pid, signal);
  });
  await assert.rejects(
    () => runDevelopmentProcess(process.execPath, [fixture], { cwd: work, env }),
    (error) => error.code === "EPERM",
  );
  const grandchild = pidFromFile(join(work, "grandchild.pid"));
  assert.equal(isAlive(grandchild), true);
  assertRestartArtifactsGone((await readGenerations(work))[0]);
});
