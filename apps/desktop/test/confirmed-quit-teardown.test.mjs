import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { register, registerHooks } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Only Electron is replaced; the quit handler, the confirmed-quit registry and
// the scheduled runner use their production code. `app.quit()` re-enters
// `before-quit` the way Electron does.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "test:electron", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:electron") return {
      format: "module", shortCircuit: true,
      source: `import { EventEmitter } from "node:events";
        export const app = new EventEmitter();
        app.quit = () => { app.emit("before-quit", { preventDefault() {} }); };
        export const globalShortcut = { unregister() {} };`,
    };
    return next(url, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { app } = await import("electron");
const { registerShutdownHandlers } = await import("../electron/main/bootstrap/shutdown.ts");
const { onConfirmedQuit, resetConfirmedQuitForTests } = await import(
  "../electron/main/bootstrap/confirmed-quit.ts"
);
const { createScheduledRunner } = await import("../electron/main/runtime/scheduled-runner.ts");

const settle = () => new Promise((resolve) => setImmediate(resolve));

function installQuitHandler(answers) {
  const state = {
    shutdownComplete: false, shutdownPromise: null, quitting: false,
    quitConfirmed: false, closeBehavior: "tray", tray: null,
    pluginLauncherAccelerator: null, toggleWindowAccelerator: null,
  };
  const dispose = () => undefined;
  const warnings = [];
  registerShutdownHandlers({
    hasSingleInstanceLock: true, state,
    getHost: () => null, getSidecar: () => null, getMcpControl: () => null,
    activeTurns: new Map(),
    persistenceOutbox: { flush: async () => {} },
    inflightCheckpointer: { flushAll: async () => {}, dispose },
    flushEventPersistence: async () => {},
    pluginPanels: { closeAll: async () => {} },
    plugins: { disposeAll: async () => {} }, userMcp: { disposeAll: dispose },
    browserHost: { dispose }, pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false },
    logger: { app: (_area, level, event) => { if (level === "warn") warnings.push(event); } },
    confirmQuitDialog: async () => answers.shift(),
    disposePowerSaveBlockers: dispose,
  });
  return { state, warnings };
}

test("a cancelled quit keeps scheduled tasks dispatching; a confirmed quit stops them", async (t) => {
  resetConfirmedQuitForTests();
  t.after(() => { app.removeAllListeners(); resetConfirmedQuitForTests(); });
  const { state } = installQuitHandler([false, true]);
  let duePolls = 0;
  const host = { async call(method) {
    assert.equal(method, "scheduled.due");
    duePolls++;
    return { ids: [] };
  } };
  const runner = createScheduledRunner({ getHost: () => host, execute: async () => {}, report: (error) => { throw error; } });
  onConfirmedQuit(() => runner.stop());

  await runner.tick();
  assert.equal(duePolls, 1);

  // Cmd+Q / tray Quit, then "Cancel" in the confirmation dialog.
  app.quit();
  await settle();
  assert.equal(state.quitting, false, "the cancelled quit leaves the app running");
  await runner.tick();
  assert.equal(duePolls, 2, "due tasks are still polled after a cancelled quit");

  // The user quits again and confirms.
  app.quit();
  await settle();
  assert.equal(state.quitting, true);
  await state.shutdownPromise;
  await runner.tick();
  assert.equal(duePolls, 2, "a committed quit stops the runner");
});

test("teardown registered after the quit is committed runs immediately and only once", async (t) => {
  resetConfirmedQuitForTests();
  t.after(() => { app.removeAllListeners(); resetConfirmedQuitForTests(); });
  const { state, warnings } = installQuitHandler([true]);
  const calls = [];
  onConfirmedQuit(() => { throw new Error("broken teardown"); });
  onConfirmedQuit(() => calls.push("early"));
  const unregistered = onConfirmedQuit(() => calls.push("unregistered"));
  unregistered();
  app.quit();
  await settle();
  await state.shutdownPromise;
  onConfirmedQuit(() => calls.push("late"));
  app.quit();
  await settle();
  assert.deepEqual(calls, ["early", "late"]);
  assert.deepEqual(warnings, ["quit teardown failed"]);
});

test("main-process services do not tear themselves down from a cancellable before-quit", async () => {
  // Only the shutdown handler may listen to `before-quit`: it alone knows
  // whether the quit was cancelled. Services use onConfirmedQuit instead.
  const root = fileURLToPath(new URL("../electron/main/", import.meta.url));
  const offenders = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        if (/\.(on|once|addListener|prependListener)\(\s*["']before-quit["']/.test(source)) {
          offenders.push(relative(root, path).replaceAll("\\", "/"));
        }
      }
    }
  };
  await visit(root);
  assert.deepEqual(offenders.sort(), ["bootstrap/shutdown.ts"]);
});
