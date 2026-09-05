import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);

test("one tray owns both minimize-to-tray and close-to-tray", () => {
  // D216's tray and D210's close-to-tray tray are the same icon. A second
  // creator would resolve its own icon path and register its own click
  // handler, so the two features would drift apart the moment either changed.
  assert.doesNotMatch(mainSource, /function createTrayIcon\b/);
  assert.doesNotMatch(mainSource, /function revealMainWindow\b/);
  assert.match(mainSource, /function createTray\(\)/);
  assert.match(mainSource, /function trayIconPath\(\)/);
  assert.match(mainSource, /function restoreMainWindow\(\)/);
});

test("the tray icon resolves through the packaged resource path", () => {
  // A hardcoded `app.getAppPath()/build/icon.png` exists only in development;
  // packaged builds ship it as `tray-icon.png` under `process.resourcesPath`.
  assert.doesNotMatch(
    mainSource,
    /join\(app\.getAppPath\(\), "build", "icon\.png"\)/,
  );
  assert.match(mainSource, /app\.isPackaged\s*\n?\s*\?\s*process\.resourcesPath/);
});

test("choosing quit never destroys the resident tray", () => {
  // The tray is the only way back from a minimized (hidden) window, so
  // switching close behavior away from "tray" must leave it alone.
  const apply = mainSource.slice(
    mainSource.indexOf("function applyCloseBehavior"),
  );
  const body = apply.slice(0, apply.indexOf("\n}\n") + 2);
  assert.match(body, /if \(next === "tray"\) createTray\(\)/);
  assert.doesNotMatch(body, /tray\.destroy\(\)/);
});

test("Windows/Linux minimize stays in the taskbar while macOS may hide to tray", () => {
  const minimize = mainSource.slice(mainSource.indexOf('window.on("minimize"'));
  const body = minimize.slice(0, minimize.indexOf("});") + 3);
  assert.match(
    body,
    /if \(quitting \|\| !tray \|\| process\.platform !== "darwin"\) return;/,
  );
  assert.match(body, /window\.hide\(\)/);

  const windowControl = mainSource.slice(
    mainSource.indexOf(
      'case "minimize":',
      mainSource.indexOf("IPC.invoke.windowControl"),
    ),
  );
  assert.match(
    windowControl.slice(0, windowControl.indexOf('case "toggleMaximize":')),
    /window\.minimize\(\)/,
  );
});

test("a stored quit preference still quits while the tray is resident", () => {
  // `window-all-closed` used to skip `app.quit()` whenever a tray existed.
  // With D216's always-present tray that meant a "quit" user could never
  // exit, so the guard now reads the user's choice instead of the tray.
  const handler = mainSource.slice(
    mainSource.indexOf('app.on("window-all-closed"'),
  );
  const body = handler.slice(0, handler.indexOf("});") + 3);
  assert.doesNotMatch(body, /!tray/);
  assert.match(body, /closeBehavior === "tray" && tray/);
  assert.match(body, /app\.quit\(\)/);

  // The close path itself quits directly rather than relying on that handler.
  assert.match(
    mainSource,
    /windowsAllowedToClose\.add\(window\);\s*\n\s*app\.quit\(\);/,
  );
});

test("permission to close does not leak into the next window", () => {
  // A module-level latch stayed true after the window it was set for closed,
  // so the window `ensureWindow()` created next skipped the prompt entirely.
  assert.doesNotMatch(mainSource, /let allowWindowClose\b/);
  assert.match(
    mainSource,
    /const windowsAllowedToClose = new WeakSet<BrowserWindow>\(\)/,
  );
  assert.match(mainSource, /windowsAllowedToClose\.has\(window\)/);
});

test("the stored close behavior is loaded before the first window", () => {
  const ready = mainSource.slice(mainSource.indexOf("app.whenReady()"));
  const readIndex = ready.indexOf("readCloseBehavior(dataDir)");
  const windowIndex = ready.indexOf("await ensureWindow()");
  assert.ok(readIndex > -1 && windowIndex > -1);
  assert.ok(
    readIndex < windowIndex,
    "close behavior must be read before a window can observe it",
  );
});

test("close behavior is not settable on macOS", () => {
  const setter = mainSource.slice(
    mainSource.indexOf("IPC.invoke.closeBehaviorSet"),
  );
  const body = setter.slice(0, setter.indexOf("\n  });") + 6);
  assert.match(body, /process\.platform === "darwin"/);
  assert.match(body, /ErrorCodes\.INVALID_ARGUMENT/);
  assert.match(body, /behavior !== "tray" && behavior !== "quit"/);
});
