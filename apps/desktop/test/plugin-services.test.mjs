import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const hostSrc = readFileSync(hostProcessEntry, "utf8");
const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const mainSrc = readFileSync(join(desktopRoot, "electron/main/index.ts"), "utf8");
const apiSrc = readFileSync(join(desktopRoot, "src/lib/api.ts"), "utf8");
const pluginsPageSrc = readFileSync(join(desktopRoot, "src/pages/PluginsPage.tsx"), "utf8");
const protocolSrc = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");
const enSrc = readFileSync(join(repoRoot, "packages/i18n/src/locales/en/index.ts"), "utf8");

/** Real host process, forked instead of Electron's utilityProcess. */
function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function createRuntime(t) {
  const audits = [];
  const changes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
    onServiceChange: (status) => changes.push(status),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits, changes };
}

/** A plugin whose single service records every start in `starts`. */
function writeServicePlugin({ permissions = ["background.service"], services, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-service-plugin-"));
  const manifest = {
    schemaVersion: 1,
    id: "com.example.service",
    name: "Service Plugin",
    version: "0.0.1",
    main: "main.js",
    permissions,
    contributes: { services: services ?? [{ id: "worker", label: "Worker" }] },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return { dir, manifest, startsFile: join(dir, "starts") };
}

/** Counts starts in the plugin directory so restarts survive a fresh process. */
const COUNTER_PRELUDE = `
  const { existsSync, readFileSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const counter = join(__dirname, "starts");
  function countStart() {
    const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    writeFileSync(counter, String(n + 1), "utf8");
    return n + 1;
  }
`;

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a declared service starts in the plugin process and reports running", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { await pi.ui.showToast("started " + countStart()); },
            stop: async () => { await pi.ui.showToast("stopped"); },
          });
        },
      };
    `,
  });
  const { runtime, audits, changes } = createRuntime(t);

  await runtime.loadFromPath(dir);

  assert.deepEqual(runtime.getServiceStates().map((s) => ({ ...s, updatedAt: 0 })), [
    {
      pluginId: "com.example.service",
      serviceId: "worker",
      label: "Worker",
      state: "running",
      restarts: 0,
      updatedAt: 0,
    },
  ]);
  // The worker ran inside the plugin process, not in the broker.
  assert.deepEqual(runtime.drainToasts(), ["started 1"]);
  assert.equal(readFileSync(startsFile, "utf8"), "1");
  assert.deepEqual(
    changes.map((c) => c.state),
    ["starting", "running"],
  );
  const started = audits.find((a) => a.api === "plugin.service.start");
  assert.deepEqual(
    { ok: started.ok, serviceId: started.serviceId },
    { ok: true, serviceId: "worker" },
  );
});

test("a service without background.service never starts", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    permissions: [],
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({ id: "worker", start: async () => { countStart(); } });
        },
      };
    `,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir, []);

  assert.deepEqual(runtime.getServiceStates(), []);
  assert.equal(existsSync(startsFile), false);
  const skipped = audits.find((a) => a.api === "plugin.services.skipped");
  assert.equal(skipped.errorCode, "PERMISSION_DENIED");
});

test("registering a service needs an id and a start function", async (t) => {
  const { dir } = writeServicePlugin({
    main: `
      module.exports = {
        async onLoad() {
          for (const bad of [{}, { id: "worker" }, { start: async () => {} }]) {
            try {
              pi.services.register(bad);
              await pi.ui.showToast("accepted");
            } catch (error) {
              await pi.ui.showToast("rejected:" + error.message);
            }
          }
          pi.services.register({ id: "worker", start: async () => {} });
        },
      };
    `,
  });
  const { runtime } = createRuntime(t);

  await runtime.loadFromPath(dir);

  assert.deepEqual(runtime.drainToasts(), [
    "rejected:service.id is required",
    "rejected:service.start must be a function",
    "rejected:service.id is required",
  ]);
  assert.equal(runtime.getServiceStates()[0].state, "running");
});

test("a service that never registered is marked failed, and the plugin stays loaded", async (t) => {
  const { dir } = writeServicePlugin({
    main: `module.exports = { async onLoad() { await pi.ui.showToast("loaded"); } };`,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir);

  const [status] = runtime.getServiceStates();
  assert.equal(status.state, "failed");
  assert.match(status.message, /worker/);
  assert.ok(runtime.getLoaded("com.example.service"), "plugin must survive a bad service");
  const failed = audits.find((a) => a.api === "plugin.service.start" && a.ok === false);
  assert.equal(failed.errorCode, "NOT_FOUND");
});

test("unloading a plugin stops its service and drops the status row", async (t) => {
  const { dir } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { await pi.ui.showToast("started " + countStart()); },
            stop: async () => { await pi.ui.showToast("stopped"); },
          });
        },
      };
    `,
  });
  const { runtime, audits, changes } = createRuntime(t);

  await runtime.loadFromPath(dir);
  await runtime.unload("com.example.service");

  assert.deepEqual(runtime.drainToasts(), ["started 1", "stopped"]);
  assert.deepEqual(runtime.getServiceStates(), []);
  assert.equal(changes.at(-1).state, "stopped");
  assert.ok(audits.some((a) => a.api === "plugin.service.stop" && a.ok));
});

test("quitting stops plugin hosts as a shutdown, not as a crash", async () => {
  const { dir } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { await pi.ui.showToast("started " + countStart()); },
            stop: async () => { await pi.ui.showToast("stopped"); },
          });
        },
        async onUnload() { await pi.ui.showToast("unloaded"); },
      };
    `,
  });
  const crashes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    onPluginCrash: (info) => crashes.push(info),
  });

  await runtime.loadFromPath(dir);
  await runtime.disposeAll();

  // The exits disposeAll causes must not surface as crashes: that is what used
  // to put an error log and an "unexpectedly stopped" toast on every quit.
  assert.deepEqual(crashes, []);
  assert.deepEqual(runtime.drainToasts(), ["started 1", "stopped", "unloaded"]);
  assert.deepEqual(runtime.getServiceStates(), []);
  assert.deepEqual(runtime.listLoaded(), []);
});

test("quitting is not held open by a plugin that will not unload", async () => {
  const { dir } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({ id: "worker", start: async () => { countStart(); } });
        },
        // Never settles: the budget, not the plugin, has to end the wait.
        onUnload() { return new Promise(() => {}); },
      };
    `,
  });
  const crashes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    onPluginCrash: (info) => crashes.push(info),
  });

  await runtime.loadFromPath(dir);
  const startedAt = Date.now();
  await runtime.disposeAll();

  assert.ok(
    Date.now() - startedAt < 6000,
    `disposeAll waited ${Date.now() - startedAt}ms on a wedged onUnload`,
  );
  assert.deepEqual(crashes, []);
  assert.deepEqual(runtime.listLoaded(), []);
});

test("app shutdown tears plugin hosts down", () => {
  const shutdown = mainSrc.slice(
    mainSrc.indexOf('logger.app("lifecycle", "info", "app shutdown")'),
    mainSrc.indexOf("const releaseQuit"),
  );
  // Watchers alone left the child processes to be killed by the quit itself,
  // which the runtime then read as a crash.
  assert.match(shutdown, /plugins\.disposeAll\(\)/);
  assert.doesNotMatch(shutdown, /plugins\.disposeWatchers\(\)/);
  // Awaited, or the app can exit before the hosts have stopped.
  assert.match(shutdown, /allSettled\(\[[^\]]*pluginShutdown/s);
});

test("a crash raises one toast, not one per reporting path", () => {
  const handler = mainSrc.slice(
    mainSrc.indexOf("onPluginCrash: ("),
    mainSrc.indexOf("onServiceChange: ("),
  );
  // The runtime already toasts on this path; a second send duplicated it.
  assert.doesNotMatch(handler, /IPC\.event\.toast/);
  assert.match(runtimeSrc, /showToast\(`Plugin stopped unexpectedly/);
});

test("a crashed host process is restarted with backoff and the restart is counted", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => {
              // Die once, right after the broker was told the service is up.
              if (countStart() === 1) setTimeout(() => process.exit(7), 30);
            },
          });
        },
      };
    `,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir);
  const failed = await waitFor(() =>
    runtime.getServiceStates().find((s) => s.state === "failed"),
  );
  assert.equal(failed.message, "plugin host process exited");

  const scheduled = await waitFor(() =>
    audits.find((a) => a.api === "plugin.service.restart.scheduled"),
  );
  // First backoff step is the base delay; attempts grow it from there.
  assert.deepEqual({ attempt: scheduled.attempt, delayMs: scheduled.delayMs }, {
    attempt: 1,
    delayMs: 1000,
  });

  const running = await waitFor(() =>
    runtime.getServiceStates().find((s) => s.state === "running"),
  );
  assert.equal(running.restarts, 1);
  assert.equal(readFileSync(startsFile, "utf8"), "2");
  assert.ok(audits.some((a) => a.api === "plugin.service.restart" && a.ok));
});

test("autoRestart:false leaves a crashed service down", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    services: [{ id: "worker", label: "Worker", autoRestart: false }],
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { countStart(); setTimeout(() => process.exit(7), 30); },
          });
        },
      };
    `,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir);
  await waitFor(() => runtime.getServiceStates().find((s) => s.state === "failed"));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(readFileSync(startsFile, "utf8"), "1");
  assert.equal(
    audits.some((a) => a.api?.startsWith("plugin.service.restart")),
    false,
  );
  assert.equal(runtime.getServiceStates()[0].state, "failed");
});

test("supervision gives up after a bounded number of restarts", () => {
  const supervise = runtimeSrc.slice(
    runtimeSrc.indexOf("private superviseCrash"),
    runtimeSrc.indexOf("private restartAfterCrash"),
  );
  assert.match(runtimeSrc, /MAX_SERVICE_RESTARTS = 5/);
  assert.match(runtimeSrc, /SERVICE_RESTART_MAX_DELAY_MS = 30_000/);
  assert.match(supervise, /record\.attempts > MAX_SERVICE_RESTARTS/);
  assert.match(supervise, /restart limit reached/);
  assert.match(supervise, /SERVICE_RESTART_MAX_DELAY_MS/);
  // A healthy run clears the counter so old crashes never shorten a later life.
  assert.match(runtimeSrc, /SERVICE_HEALTHY_MS = 60_000/);
  assert.match(runtimeSrc, /private scheduleHealthyReset/);
  assert.match(runtimeSrc, /MAX_SERVICES_PER_PLUGIN = 4/);
});

test("the plugin process owns service callables and forgets them on unload", () => {
  const startCase = hostSrc.slice(hostSrc.indexOf('case "service.start"'));
  // Starting an already-running service must be a no-op, not a second worker.
  assert.match(startCase, /alreadyRunning/);
  const unloadCase = hostSrc.slice(hostSrc.indexOf('case "lifecycle.unload"'));
  assert.match(unloadCase, /services\.clear\(\)/);
  // Registration is local bookkeeping: the broker decides when a service runs.
  assert.doesNotMatch(hostSrc, /"services\.register"/);
});

test("service status reaches the renderer over its own channel", () => {
  assert.match(protocolSrc, /pluginServices: "pi-desktop\/plugin\/services"/);
  assert.match(mainSrc, /IPC\.invoke\.pluginServices/);
  assert.match(mainSrc, /plugins\.getServiceStates\(\)/);
  assert.match(mainSrc, /reason: "service"/);
  assert.match(apiSrc, /listPluginServices/);
});

test("the plugins page keeps capability and service chips in row details", () => {
  assert.match(pluginsPageSrc, /<CapabilityChips capabilities=\{plugin\.capabilities\} \/>/);
  assert.match(pluginsPageSrc, /<ServiceChips statuses=\{services\} \/>/);
  assert.match(pluginsPageSrc, /<details className="plugins-row-details">/);
  assert.match(
    pluginsPageSrc,
    /<PluginRowDetails[\s\S]*?services=\{servicesByPlugin\.get\(plugin\.id\)\}/,
  );
  assert.match(pluginsPageSrc, /\.listPluginServices\(\)/);
  assert.match(pluginsPageSrc, /api\.onPluginChanged\(refresh\)/);
  for (const key of ["serviceState", "serviceRestarts", "capabilities"]) {
    assert.match(pluginsPageSrc, new RegExp(`plugins\\.${key}`));
    assert.match(enSrc, new RegExp(`${key}:`));
  }
});
