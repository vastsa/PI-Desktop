import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const id = "pi.official-enhancements";
const pluginDir = fileURLToPath(new URL(`../resources/plugins/${id}/`, import.meta.url));
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

function spawnProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  return {
    postMessage: (message) => { if (child.connected) child.send(message); },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

test("bundled Enhancements titles the first turn and keeps other features opt-in", { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-enhancements-"));
  const previousData = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = dataDir;
  const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
  const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
  const { promise: titleWritten, resolve: receiveTitle } = Promise.withResolvers();
  const completions = [];
  const contextReads = [];
  const transcriptReads = [];
  const suggestions = [];
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess,
    getActiveSession: () => ({ sessionId: "session-1", modelKey: "fixture/model" }),
    isPluginActiveInProject: (pluginId) => pluginId === id,
    suggestComposer: async (offer) => { suggestions.push(offer); return { shown: true }; },
    listModels: async () => [{ key: "fixture/model", isDefault: true }],
    complete: async (request) => {
      completions.push(request);
      return { text: completions.length === 1 ? "New generated title" : "Improved draft" };
    },
    session: {
      getAutoTitleContext: async (_id, { sessionId }) => {
        contextReads.push(sessionId);
        return sessionId === "session-1"
          ? { expectedTitle: "First draft", userPrompt: "Review this draft", assistantReply: "Reviewed the draft" }
          : null;
      },
      setAutoTitle: async (pluginId, request) => {
        receiveTitle({ pluginId, ...request });
        return { updated: true };
      },
      listMessages: async (...args) => { transcriptReads.push(args); return { items: [] }; },
    },
  });
  t.after(async () => {
    try { await runtime.unload(id); }
    finally {
      if (previousData === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
      else process.env.PI_DESKTOP_DATA_DIR = previousData;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  assert.equal(manifest.id, id);
  assert.equal(manifest.enabledByDefault, true);
  const load = () => runtime.loadFromPath(pluginDir, manifest.permissions);
  const invoke = (channel, payload) => runtime.invokePanelBridge(id, channel, payload);
  const turn = (sessionId, turnId) => runtime.broadcastEvent("session:turnEnded", [{ sessionId, turnId, reason: "completed" }]);
  const transform = () => runtime.runComposerTransform({ pluginId: id, id: "enhance", text: "Review draft" });
  await load();
  const { settings } = await invoke("enhancements.panelState");
  assert.equal(settings.titlesEnabled, true);
  assert.equal(settings.predictionsEnabled, false);
  assert.equal(settings.promptEnhancementEnabled, false);
  const memoryState = await invoke("memory.state");
  assert.equal(memoryState.ok, true, JSON.stringify(memoryState));
  assert.equal(memoryState.settings.enabled, false);
  const memory = runtime.getTools().find((tool) => tool.pluginId === id && tool.name === "memory");
  assert.ok(memory);
  await assert.rejects(memory.execute({ action: "recall" }, { sessionId: "session-1" }), { code: "MEMORY_DISABLED" });
  await assert.rejects(transform(), { code: "ENHANCEMENT_DISABLED" });
  assert.equal((await invoke("enhancements.testModel")).code, "ENHANCEMENT_DISABLED");
  assert.deepEqual(completions, []);

  turn("session-1", "turn-1");
  assert.deepEqual(await titleWritten, {
    pluginId: id, sessionId: "session-1", expectedTitle: "First draft", title: "New generated title",
  });
  assert.match(completions[0].messages[0].content, /Review this draft[\s\S]*Reviewed the draft/);
  assert.equal(completions[0].includeSessionContext, false);
  assert.equal(completions.length, 1);
  assert.deepEqual(transcriptReads, []);
  assert.deepEqual(suggestions, []);

  // Save explicit choices through the actual panel bridge and reload the process.
  const saved = await invoke("enhancements.saveSettings", { titlesEnabled: false, promptEnhancementEnabled: true });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await runtime.unload(id);
  await load();
  const reloaded = (await invoke("enhancements.panelState")).settings;
  assert.equal(reloaded.titlesEnabled, false);
  assert.equal(reloaded.predictionsEnabled, false);
  assert.equal(reloaded.promptEnhancementEnabled, true);
  turn("session-1", "turn-2");
  assert.equal(await transform(), "Improved draft");
  assert.deepEqual(contextReads, ["session-1"]);
  assert.equal(completions.length, 2);
});
