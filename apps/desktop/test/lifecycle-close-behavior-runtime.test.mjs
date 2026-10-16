import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-lifecycle-close-runtime-"));
after(async () => rm(temp, { recursive: true, force: true }));
const electronStub = join(temp, "electron-stub.mjs");
await writeFile(electronStub, `
export const dialog = {
  async showMessageBox(...args) {
    const options = args.length > 1 ? args[1] : args[0];
    globalThis.__nativeDialogOptions.push(options);
    if (globalThis.__nativeDialogFailure) throw new Error("native dialog unavailable");
    return { response: globalThis.__nativeDialogResponses.shift() ?? 0 };
  },
};`);
const bundlePath = join(temp, "close-behavior.mjs");
await build({
  entryPoints: [join(root, "apps/desktop/electron/main/bootstrap/close-behavior.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
  alias: {
    electron: electronStub,
    "@pi-desktop/i18n": join(root, "packages/i18n/src"),
    "@pi-desktop/shared": join(root, "packages/shared/src"),
  },
  nodePaths: [join(root, "apps/desktop/node_modules")],
});
const { createCloseBehaviorRuntime } = await import(pathToFileURL(bundlePath).href);

function fakeWindow({ visible = true, minimized = false } = {}) {
  const events = [];
  const listeners = new Map();
  const onceListeners = new Map();
  const contents = {
    id: 41,
    isDestroyed: () => false,
    send(channel, payload) { events.push({ channel, payload }); },
    on(event, listener) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
    once(event, listener) {
      const current = onceListeners.get(event) ?? [];
      current.push(listener);
      onceListeners.set(event, current);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
      for (const listener of onceListeners.get(event) ?? []) listener(...args);
      onceListeners.delete(event);
    },
  };
  const window = {
    webContents: contents,
    restoreCount: 0,
    showCount: 0,
    focusCount: 0,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore() { this.restoreCount += 1; minimized = false; visible = true; },
    show() { this.showCount += 1; visible = true; },
    focus() { this.focusCount += 1; },
  };
  return { window, events, emit: contents.emit };
}

function createRuntime(window, dataDir) {
  const logs = [];
  let trayCreations = 0;
  const runtime = createCloseBehaviorRuntime({
    state: { mainWindow: window, closeBehavior: "ask" },
    dataDir,
    getLocale: () => "en",
    createTray: () => { trayCreations += 1; },
    logger: { app: (...entry) => logs.push(entry) },
  });
  return { runtime, logs, trayCreations: () => trayCreations };
}

function lastEvent(events, channel) {
  return events.findLast((event) => event.channel === channel);
}

test("renderer choices drive close and quit while unavailable renderers use native fallback", async () => {
  globalThis.__nativeDialogOptions = [];
  globalThis.__nativeDialogResponses = [];
  globalThis.__nativeDialogFailure = false;
  const { window, events, emit } = fakeWindow({ visible: false, minimized: true });
  const { runtime, trayCreations } = createRuntime(window, join(temp, "profile"));
  assert.equal(runtime.markLifecycleDialogRendererReady(window), true);

  const quitCancelled = runtime.confirmQuitDialog();
  assert.equal(window.restoreCount, 1);
  assert.equal(window.focusCount, 1);
  const firstQuit = lastEvent(events, "pi-desktop/window/event/lifecycleDialogRequest");
  assert.equal(firstQuit.payload.kind, "quit-confirmation");
  assert.equal(runtime.respondLifecycleDialog(99, firstQuit.payload.requestId, "confirm"), false);
  assert.equal(runtime.respondLifecycleDialog(41, firstQuit.payload.requestId, "cancel"), true);
  assert.equal(await quitCancelled, false);

  const quitConfirmed = runtime.confirmQuitDialog();
  const secondQuit = lastEvent(events, "pi-desktop/window/event/lifecycleDialogRequest");
  assert.equal(runtime.respondLifecycleDialog(41, secondQuit.payload.requestId, "confirm"), true);
  assert.equal(await quitConfirmed, true);

  const closeChoice = runtime.askCloseBehavior(window);
  const closeRequest = lastEvent(events, "pi-desktop/window/event/lifecycleDialogRequest");
  assert.equal(closeRequest.payload.kind, "close-behavior");
  assert.equal(runtime.respondLifecycleDialog(41, closeRequest.payload.requestId, "tray"), true);
  assert.equal(await closeChoice, "tray");
  runtime.applyCloseBehavior("tray");
  assert.equal(runtime.readCloseBehavior(), "tray");
  assert.equal(trayCreations(), 1);

  globalThis.__nativeDialogResponses.push(2);
  const fallbackChoice = runtime.askCloseBehavior(window);
  const fallbackRequest = lastEvent(events, "pi-desktop/window/event/lifecycleDialogRequest");
  emit("render-process-gone");
  assert.equal(await fallbackChoice, "quit");
  assert.equal(
    lastEvent(events, "pi-desktop/window/event/lifecycleDialogDismiss").payload.requestId,
    fallbackRequest.payload.requestId,
  );
  const nativeAsk = globalThis.__nativeDialogOptions.at(-1);
  assert.equal(nativeAsk.title, "Keep PI-Desktop running in the background?");
  assert.equal(nativeAsk.message.startsWith("When you close the window"), true);

  globalThis.__nativeDialogResponses.push(0);
  assert.equal(await runtime.confirmQuitDialog(), false);
  const nativeQuit = globalThis.__nativeDialogOptions.at(-1);
  assert.equal(nativeQuit.title, "Quit PI-Desktop?");
  assert.notEqual(nativeQuit.message, nativeQuit.title);
});
