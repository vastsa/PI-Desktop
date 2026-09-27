import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);

test("the single-instance lock is taken before anything touches the data directory", () => {
  // Electron keeps the lock under `userData`, which is derived from the app
  // name, so the name has to be set first. Everything after it in this module
  // writes into the data directory of whichever instance is already running:
  // the logger creates the log tree, the outbox loads and rewrites the queued
  // appends. A duplicate launch must be gone before either happens.
  const lock = mainSource.indexOf("app.requestSingleInstanceLock()");
  assert.ok(lock > 0, "main must request the single-instance lock");
  assert.ok(mainSource.indexOf("app.setName(APP_NAME)") < lock);
  assert.ok(lock < mainSource.indexOf("new Logger("));
  assert.ok(lock < mainSource.indexOf("new PersistenceOutbox("));
});

test("a launch that loses the lock quits and boots nothing", () => {
  const guard = mainSource.slice(
    mainSource.indexOf("if (!hasSingleInstanceLock) {"),
  );
  assert.match(guard.slice(0, guard.indexOf("\n}\n") + 2), /app\.quit\(\)/);

  // `app.quit()` before readiness is not guaranteed to preempt `ready`, so the
  // boot path refuses to run a second window, tray, host, or sidecar on top of
  // the running app.
  const ready = mainSource.slice(mainSource.indexOf("app.whenReady().then("));
  const readyPrologue = ready.slice(0, ready.indexOf("createTray()"));
  assert.match(readyPrologue, /if \(!hasSingleInstanceLock\) return;/);

  // The duplicate owns no host, sidecar, panel, or outbox, and the shutdown
  // sequence logs into the shared data directory. It must exit straight away.
  const beforeQuit = mainSource.slice(
    mainSource.indexOf('app.on("before-quit"'),
  );
  const beforeQuitPrologue = beforeQuit.slice(
    0,
    beforeQuit.indexOf("shutdownPromise = "),
  );
  assert.match(beforeQuitPrologue, /if \(!hasSingleInstanceLock\) return;/);
});

test("a second launch surfaces the running window instead of a new one", () => {
  const handler = mainSource.slice(mainSource.indexOf('app.on("second-instance"'));
  const body = handler.slice(0, handler.indexOf("});") + 3);
  assert.match(body, /restoreMainWindow\(\)/);
  assert.doesNotMatch(body, /new BrowserWindow|createWindow\(\)/);
});

test("a run with its own data directory keeps the current start behavior", () => {
  // The lock is scoped to the installation, not to `PI_DESKTOP_DATA_DIR`. E2E
  // harnesses, the capture rig, and side-by-side profiles point at their own
  // data directory, share no database, outbox, or logs with the default
  // installation, and have to stay launchable while one is running.
  assert.match(
    mainSource,
    /const singleInstanceRequired = !process\.env\.PI_DESKTOP_DATA_DIR;/,
  );
  assert.match(
    mainSource,
    /const hasSingleInstanceLock = singleInstanceRequired\s*\n?\s*\? app\.requestSingleInstanceLock\(\)\s*\n?\s*: true;/,
  );
});
