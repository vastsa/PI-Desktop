import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { createPluginSessionContext } = await import(
  "../electron/main/services/plugin-session-context.ts"
);

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => child.connected && child.send(message),
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

/** A plugin that contributes views, so `ui.revealView` has something to name. */
function writeViewPlugin({ id, permissions, views, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-follow-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
      contributes: { views },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  for (const view of views) {
    const entry = join(dir, view.entry);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "<!doctype html><html><body></body></html>", "utf8");
  }
  return dir;
}

async function runCommand(runtime, id) {
  const command = runtime.getCommands().find((entry) => entry.id === id);
  assert.ok(command, `command not registered: ${id}`);
  await command.run();
}

const CHANGES_VIEW = { id: "changes", title: "Changes", entry: "views/changes.html" };

test("session snapshot reports the selection and the running turn", () => {
  const announced = [];
  const liveTurns = new Map();
  const context = createPluginSessionContext({
    getActiveTurn: (sessionId) => liveTurns.get(sessionId) ?? null,
    announce: (event, payload) => announced.push([event, payload]),
    now: () => 1_000,
  });

  assert.equal(context.snapshot(), null);

  context.setActiveSession({ sessionId: "s1", projectPath: "/work/pi" });
  assert.deepEqual(context.snapshot(), {
    sessionId: "s1",
    projectPath: "/work/pi",
    activeTurn: null,
  });

  // A turn opening in another session is not the selected session's business.
  liveTurns.set("s2", "turn-2");
  context.noteTurnStarted("s2", "turn-2");
  liveTurns.set("s1", "turn-1");
  context.noteTurnStarted("s1", "turn-1");

  assert.deepEqual(context.snapshot(), {
    sessionId: "s1",
    projectPath: "/work/pi",
    activeTurn: { turnId: "turn-1", startedAt: 1_000 },
  });
  // Selection, then the selected session's turn start.
  assert.equal(announced.length, 2);
  assert.equal(announced[0][0], "session:activated");
  assert.equal(announced[1][1].activeTurn.turnId, "turn-1");
});

test("session snapshot goes idle on turn end and drops a turn the host forgot", () => {
  const announced = [];
  const liveTurns = new Map();
  const context = createPluginSessionContext({
    getActiveTurn: (sessionId) => liveTurns.get(sessionId) ?? null,
    announce: (event, payload) => announced.push([event, payload]),
  });
  context.setActiveSession({ sessionId: "s1", projectPath: null });
  liveTurns.set("s1", "turn-1");
  context.noteTurnStarted("s1", "turn-1");
  assert.equal(context.snapshot().activeTurn.turnId, "turn-1");

  // A recorded start is only reported while the host still owns that turn: a
  // turn that ended without a notice must not pin a stale "running" state.
  liveTurns.delete("s1");
  assert.equal(context.snapshot().activeTurn, null);

  liveTurns.set("s1", "turn-1");
  context.noteTurnEnded("s1", "turn-1");
  liveTurns.delete("s1");
  assert.equal(context.snapshot().activeTurn, null);
  assert.equal(announced.at(-1)[0], "session:activated");
  assert.equal(announced.at(-1)[1].activeTurn, null);
});

test("an unchanged snapshot is announced once", () => {
  const announced = [];
  const context = createPluginSessionContext({
    getActiveTurn: () => null,
    announce: (event, payload) => announced.push([event, payload]),
  });
  context.setActiveSession({ sessionId: "s1", projectPath: "/work/pi" });
  context.setActiveSession({ sessionId: "s1", projectPath: "/work/pi" });
  context.setActiveSession({ sessionId: "s1", projectPath: "/work/pi" });
  assert.equal(announced.length, 1);

  // A blank path is "no project", which is a real change, not a repeat.
  context.setActiveSession({ sessionId: "s1", projectPath: "  " });
  assert.equal(announced.length, 2);
  assert.equal(announced[1][1].projectPath, null);
  context.setActiveSession(null);
  assert.equal(announced.length, 3);
  assert.equal(announced[2][1], null);
});

test("plugin session follow reads the snapshot and refuses a stale reveal", async (t) => {
  const revealed = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getActiveSession: () => ({
      sessionId: "s1",
      projectPath: "/work/pi",
      activeTurn: { turnId: "turn-1", startedAt: 1_000 },
    }),
    isPluginActiveInProject: () => true,
    revealView: async (request) => revealed.push(request),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });

  const dir = writeViewPlugin({
    id: "demo.follow",
    permissions: ["ui.view"],
    views: [CHANGES_VIEW],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "exercise",
            title: "Exercise",
            run: async () => {
              const active = await pi.session.getActive();
              await pi.ui.showToast("active:" + active.sessionId + ":" + active.activeTurn.turnId);
              // No view id: the plugin contributes exactly one view.
              await pi.ui.revealView({ location: "src/App.tsx" });
              try { await pi.ui.revealView({ viewId: "changes", sessionId: "s0" }); }
              catch (error) { await pi.ui.showToast("stale:" + error.code); }
              try { await pi.ui.revealView({ viewId: "missing" }); }
              catch (error) { await pi.ui.showToast("view:" + error.code); }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["ui.view"]);
  await runCommand(runtime, "exercise");

  assert.deepEqual(runtime.drainToasts(), [
    "active:s1:turn-1",
    "stale:INVALID_ARGUMENT",
    "view:NOT_FOUND",
  ]);
  assert.deepEqual(revealed, [
    {
      pluginId: "demo.follow",
      viewId: "changes",
      sessionId: "s1",
      location: "src/App.tsx",
    },
  ]);
});

test("revealing a work-panel view requires the view permission", async (t) => {
  const revealed = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getActiveSession: () => ({ sessionId: "s1", projectPath: null, activeTurn: null }),
    isPluginActiveInProject: () => true,
    revealView: async (request) => revealed.push(request),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writeViewPlugin({
    id: "demo.no-view-grant",
    permissions: [],
    views: [CHANGES_VIEW],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "exercise",
            title: "Exercise",
            run: async () => {
              try { await pi.ui.revealView(); }
              catch (error) { await pi.ui.showToast(error.code); }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, []);
  await runCommand(runtime, "exercise");
  assert.deepEqual(runtime.drainToasts(), ["PERMISSION_DENIED"]);
  assert.deepEqual(revealed, []);
});

test("a docked view reads the same snapshot through the panel bridge", async (t) => {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getActiveSession: () => ({ sessionId: "s7", projectPath: "/work/pi", activeTurn: null }),
    isPluginActiveInProject: () => true,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writeViewPlugin({
    id: "demo.view-bridge",
    permissions: ["ui.view"],
    views: [CHANGES_VIEW],
    main: "module.exports = { async onLoad() {} };",
  });
  await runtime.loadFromPath(dir, ["ui.view"]);
  const snapshot = await runtime.invokePanelBridge("demo.view-bridge", "session.getActive");
  assert.deepEqual(snapshot, { sessionId: "s7", projectPath: "/work/pi", activeTurn: null });
});

test("a project-scoped plugin cannot follow or reveal outside its project", async (t) => {
  const revealed = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getActiveSession: () => ({ sessionId: "s9", projectPath: "/work/other", activeTurn: null }),
    isPluginActiveInProject: () => false,
    revealView: async (request) => revealed.push(request),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writeViewPlugin({
    id: "demo.out-of-scope",
    permissions: ["ui.view"],
    views: [CHANGES_VIEW],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "exercise",
            title: "Exercise",
            run: async () => {
              try { await pi.session.getActive(); }
              catch (error) { await pi.ui.showToast("active:" + error.code); }
              try { await pi.ui.revealView(); }
              catch (error) { await pi.ui.showToast("reveal:" + error.code); }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["ui.view"]);
  await runCommand(runtime, "exercise");
  assert.deepEqual(runtime.drainToasts(), [
    "active:PERMISSION_DENIED",
    "reveal:PERMISSION_DENIED",
  ]);
  assert.deepEqual(revealed, []);
});

test("turn start times stay bounded when a turn ends without a notice", () => {
  const announced = [];
  const liveTurns = new Map();
  const context = createPluginSessionContext({
    getActiveTurn: (sessionId) => liveTurns.get(sessionId) ?? null,
    announce: (event, payload) => announced.push([event, payload]),
  });
  // Far more sessions than the cap: the map must not grow with the app's life.
  for (let index = 0; index < 500; index += 1) {
    context.noteTurnStarted(`session-${index}`, `turn-${index}`);
  }
  for (const sessionId of ["session-0", "session-100", "session-499"]) {
    liveTurns.set(sessionId, sessionId.replace("session", "turn"));
  }
  context.setActiveSession({ sessionId: "session-499", projectPath: null });
  assert.equal(context.snapshot().activeTurn.turnId, "turn-499");
  assert.equal(typeof context.snapshot().activeTurn.startedAt, "number");
  // The oldest insertions were dropped, so switching back reports no turn start
  // rather than a start time that no longer exists.
  context.setActiveSession({ sessionId: "session-0", projectPath: null });
  assert.equal(context.snapshot().activeTurn, null);
});

test("broadcastEvent's filter keeps an out-of-scope plugin from receiving the session push", async (t) => {
  const sent = [];
  const spawnWithSpy = (options) => {
    const proc = forkPluginProcess(options);
    const ownerId = currentId;
    const originalPostMessage = proc.postMessage;
    proc.postMessage = (message) => {
      sent.push({ plugin: ownerId, message });
      originalPostMessage(message);
    };
    return proc;
  };
  let currentId = "demo.in-scope";
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: spawnWithSpy,
    isPluginActiveInProject: (pluginId) => pluginId === "demo.in-scope",
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });

  await runtime.loadFromPath(
    writeViewPlugin({
      id: "demo.in-scope",
      permissions: ["ui.view"],
      views: [CHANGES_VIEW],
      main: "module.exports = { async onLoad() {} };",
    }),
    ["ui.view"],
  );
  currentId = "demo.out-of-scope";
  await runtime.loadFromPath(
    writeViewPlugin({
      id: "demo.out-of-scope",
      permissions: ["ui.view"],
      views: [CHANGES_VIEW],
      main: "module.exports = { async onLoad() {} };",
    }),
    ["ui.view"],
  );

  const payload = { sessionId: "s-other", projectPath: "/work/other" };
  runtime.broadcastEvent(
    "session:activated",
    [payload],
    (pluginId) => pluginId === "demo.in-scope",
  );
  await new Promise((resolve) => setImmediate(resolve));

  const events = sent.filter((entry) => entry.message?.event === "session:activated");
  assert.equal(events.length, 1, "exactly the in-scope plugin process received the push");
  assert.equal(events[0].plugin, "demo.in-scope");
  assert.deepEqual(events[0].message.args, [payload]);
});

test("the session-push gate restarts with the renderer's boot id and the payload carries it", async () => {
  const { readMainSource, readStoreModule } = await import("./helpers/source-contracts.mjs");
  const { readFile } = await import("node:fs/promises");
  const gateSource = await readFile(
    new URL("../electron/main/plugin-session-push-gate.ts", import.meta.url),
    "utf8",
  );

  // The gate module owns the boot-id reset (#1753): a new renderer boot
  // restarts the high-water mark, and within a boot the out-of-order guard
  // still ignores older sequences.
  assert.match(
    gateSource,
    /push\.bootId !== activeSessionBootId[\s\S]*?activeSessionSeq = push\.seq;[\s\S]*?return \{ ok: true, ignored: true \};/,
    "the gate must reset the high-water mark on a new renderer boot and keep the out-of-order guard within a boot",
  );

  // The production handler gates every push through the shared gate.
  const ipcSource = await readMainSource("ipc/plugin-ui-ipc.ts");
  assert.match(
    ipcSource,
    /const sessionPushGate = createSessionPushGate\(\);[\s\S]*?sessionPushGate\(\{ seq, bootId \}\)\.ignored/,
    "plugin-ui-ipc must route session pushes through the shared gate",
  );

  // Renderer: the push carries the boot id the gate compares.
  const runtimeSource = await readStoreModule("../../src/features/app/useAppShellRuntime.tsx");
  assert.match(
    runtimeSource,
    /sessionPushBootId\s*=\s*useRef\(crypto\.randomUUID\(\)\)/,
    "the renderer must own a per-load boot id",
  );
  assert.match(
    runtimeSource,
    /bootId:\s*sessionPushBootId\.current/,
    "the push must carry the boot id",
  );
});

test("the session-push gate accepts a new renderer boot and still rejects an older sequence within it (#1753)", async (t) => {
  const { createSessionPushGate } = await import(
    "../electron/main/plugin-session-push-gate.ts"
  );
  const gate = createSessionPushGate();

  // Within one boot: in-order accepted, out-of-order ignored.
  assert.deepEqual(gate({ seq: 3, bootId: "boot-1" }), { ok: true });
  assert.deepEqual(gate({ seq: 5, bootId: "boot-1" }), { ok: true });
  assert.deepEqual(gate({ seq: 4, bootId: "boot-1" }), {
    ok: true,
    ignored: true,
  });

  // A reload restarts the renderer counter: the new boot resets the mark and
  // the low sequences flow again.
  assert.deepEqual(gate({ seq: 1, bootId: "boot-2" }), { ok: true });
  assert.deepEqual(gate({ seq: 2, bootId: "boot-2" }), { ok: true });
  assert.deepEqual(gate({ seq: 1, bootId: "boot-2" }), {
    ok: true,
    ignored: true,
  });

  // Zero-sequence pushes (no selection) never touch the mark.
  assert.deepEqual(gate({ seq: 0, bootId: "boot-2" }), { ok: true });
  assert.deepEqual(gate({ seq: 2, bootId: "boot-2" }), { ok: true });
});
