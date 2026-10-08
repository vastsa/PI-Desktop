import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Only Electron is replaced; event persistence, the disk outbox and the quit
// handler use their production wiring. No user profile is opened by this test.
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
        app.quit = () => {};
        export const globalShortcut = { unregister() {} };`,
    };
    return next(url, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { app } = await import("electron");
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");
const { registerShutdownHandlers } = await import("../electron/main/bootstrap/shutdown.ts");

for (const outcome of ["complete", "error", "unresponsive"]) {
test(`quit settles a regenerated branch when the host is ${outcome}`, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-quit-regenerate-"));
  const archiveStarted = Promise.withResolvers();
  const releaseArchive = Promise.withResolvers();
  const sidecarStopped = Promise.withResolvers();
  const messages = new Map();
  const archived = [];
  const warnings = [];
  const activeTurns = new Map([["session", "turn"]]);
  let hostDisposed = false;
  const host = {
    isAvailable: () => !hostDisposed,
    async call(method, params) {
      assert.equal(hostDisposed, false, "persistence requires a live host");
      if (method === "session.appendMessage") messages.set(params.message.id, params.message);
      if (method === "session.saveActiveRevision") {
        archiveStarted.resolve();
        await releaseArchive.promise;
        if (outcome === "error") throw new Error("archive storage unavailable");
        assert.equal(hostDisposed, false, "the archive must finish before host disposal");
        archived.push([...messages.values()]);
      }
      return {};
    },
    async dispose() { hostDisposed = true; },
  };
  const logger = { app: (_area, level, event) => {
    if (level === "warn") warnings.push(event);
  } };
  const outbox = new PersistenceOutbox(dataDir, () => undefined);
  const checkpoint = {
    observe() {}, flush: async () => {}, flushAll: async () => {},
    settleIf() {}, dispose() {},
  };
  const persistence = createEventPersistence({
    runtimeState: { host }, steeringReplies: new Set(), activeTurns,
    activeToolCalls: new Map(), activeToolCallKey: (s, c) => `${s}:${c}`,
    approvedExecutionIdsBySession: new Map(), approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(), planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: (s, turn) => `${s}:${turn}`,
    inflightCheckpointer: checkpoint, persistenceOutbox: outbox,
    addActiveTurnUsage() {}, logger,
    finishTurn: async () => { activeTurns.clear(); },
    isStaleTerminalEvent: () => false,
    finishApprovedExecution: async () => {}, emitAgentEvent() {},
  });
  const state = {
    shutdownComplete: false, shutdownPromise: null, quitting: false,
    quitConfirmed: true, closeBehavior: "quit", tray: null,
    pluginLauncherAccelerator: null, toggleWindowAccelerator: null,
  };
  const dispose = () => undefined;
  registerShutdownHandlers({
    hasSingleInstanceLock: true, state,
    getHost: () => host,
    getSidecar: () => ({ dispose: async () => { sidecarStopped.resolve(); } }),
    getMcpControl: () => null, activeTurns, persistenceOutbox: outbox,
    inflightCheckpointer: checkpoint,
    flushEventPersistence: () => persistence.flush(),
    pluginPanels: { closeAll: async () => {} },
    plugins: { disposeAll: async () => {} }, userMcp: { disposeAll: dispose },
    browserHost: { dispose }, pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false }, logger,
    confirmQuitDialog: async () => true, disposePowerSaveBlockers: dispose,
  });
  t.after(async () => {
    releaseArchive.resolve();
    await state.shutdownPromise;
    await persistence.flush();
    app.removeAllListeners();
  });
  const reply = {
    id: "answer", role: "assistant", content: "Completed regenerated answer",
    createdAt: new Date(0).toISOString(), status: "complete",
  };
  persistence.persistAgentEvent({ sessionId: "session", turnId: "turn", ts: 1,
    event: { type: "message_end", message: reply } });
  persistence.persistAgentEvent({ sessionId: "session", turnId: "turn", ts: 2,
    event: { type: "agent_end", messageIds: [reply.id] } });
  await archiveStarted.promise;
  if (outcome === "unresponsive") t.mock.timers.enable({ apis: ["setTimeout"] });
  app.emit("before-quit", { preventDefault() {} });
  await sidecarStopped.promise;
  assert.equal(hostDisposed, false, "quit must wait for the branch already being saved");
  if (outcome === "unresponsive") {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2_000);
    await state.shutdownPromise;
    assert.equal(hostDisposed, true, "an unresponsive archive cannot prevent quitting");
    assert.deepEqual(warnings, ["quit before event persistence settled"]);
    return;
  }
  releaseArchive.resolve();
  await state.shutdownPromise;
  assert.deepEqual(archived, outcome === "complete" ? [[reply]] : []);
  assert.deepEqual(warnings, outcome === "complete" ? [] : ["save active regenerate branch failed"]);
  assert.equal(hostDisposed, true);
});
}
