import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "../electron/main/plugin-host-process.mjs");

// Set before the runtime is imported so per-plugin data lands in a throwaway
// directory instead of the developer's real one.
process.env.PI_DESKTOP_DATA_DIR = mkdtempSync(join(tmpdir(), "pi-renderer-call-data-"));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

/*
 * A renderer extension against the real runtime and a real plugin host
 * process (`docs/plugin-plan/render/plugin-call/`): the descriptor and the
 * source resolver follow the live load, and `plugin.call` crosses the process
 * boundary to the plugin's `onRendererCall` and back with its codes intact.
 */

const RENDERER_CALL_MAIN = `
  module.exports = {
    onLoad() {},
    async onRendererCall(method, args) {
      if (method === "echo") return { method, args };
      if (method === "coded") throw Object.assign(new Error("not ready"), { code: "LAB_NOT_READY" });
      if (method === "fail") throw new Error("boom");
      if (method === "bigint") return { n: 1n };
      if (method === "silent") return new Promise(() => {});
      return null;
    },
  };
`;

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

function writePlugin(t, { id, main = RENDERER_CALL_MAIN }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-renderer-call-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "renderer"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      renderer: "renderer/index.js",
      rendererActions: ["plugin.call"],
      rendererCallMethods: ["echo", "coded", "fail", "bigint", "silent"],
      permissions: ["renderer.extension"],
      contributes: { agentTools: [{ name: "lookup", description: "Look something up" }] },
    }),
  );
  writeFileSync(join(dir, "main.js"), main);
  writeFileSync(join(dir, "renderer/index.js"), "export function onLoad() {}\n");
  return dir;
}

function runtimeFor(t) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getWorkspacePath: () => null,
    audit: () => {},
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return runtime;
}

function refusedWith(code, pattern) {
  return (error) => {
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

test("the descriptor and the served sources follow the plugin's current load", async (t) => {
  const runtime = runtimeFor(t);
  const dir = writePlugin(t, { id: "lab.sources" });
  const entry = realpathSync(join(dir, "renderer/index.js"));
  await runtime.loadFromPath(dir, ["renderer.extension"]);

  const first = runtime.rendererDescriptor("lab.sources");
  assert.deepEqual(first, {
    entry: "renderer/index.js",
    generation: first.generation,
    actions: ["plugin.call"],
    callMethods: ["echo", "coded", "fail", "bigint", "silent"],
    tools: ["lookup"],
  });
  assert.equal(runtime.resolveRendererSource("lab.sources", first.generation, "renderer/index.js"), entry);
  assert.equal(runtime.resolveRendererSource("lab.sources", first.generation, "main.js"), realpathSync(join(dir, "main.js")));
  assert.equal(runtime.resolveRendererSource("lab.sources", first.generation, "../main.js"), null);
  assert.equal(runtime.resolveRendererSource("lab.other", first.generation, "renderer/index.js"), null);

  // A reload is a new load: new generation, and the old URLs stop resolving.
  await runtime.loadFromPath(dir, ["renderer.extension"]);
  const second = runtime.rendererDescriptor("lab.sources");
  assert.ok(second.generation > first.generation);
  assert.equal(runtime.resolveRendererSource("lab.sources", first.generation, "renderer/index.js"), null);
  assert.equal(runtime.resolveRendererSource("lab.sources", second.generation, "renderer/index.js"), entry);

  await runtime.unload("lab.sources");
  assert.equal(runtime.rendererDescriptor("lab.sources"), undefined);
  assert.equal(runtime.resolveRendererSource("lab.sources", second.generation, "renderer/index.js"), null);
});

test("plugin.call reaches onRendererCall in the plugin process and returns its answer or its code", async (t) => {
  const runtime = runtimeFor(t);
  await runtime.loadFromPath(writePlugin(t, { id: "lab.calls" }), ["renderer.extension"]);

  assert.deepEqual(await runtime.callRenderer("lab.calls", "echo", { n: 1, list: ["a"] }), {
    method: "echo",
    args: { n: 1, list: ["a"] },
  });
  assert.deepEqual(
    await runtime.callRenderer("lab.calls", "echo", undefined),
    { method: "echo", args: {} },
    "omitted args reach the plugin as {}",
  );
  await assert.rejects(runtime.callRenderer("lab.calls", "coded"), refusedWith("LAB_NOT_READY", /^not ready$/));
  await assert.rejects(runtime.callRenderer("lab.calls", "fail"), refusedWith("PLUGIN_CALL_FAILED", /^boom$/));
  await assert.rejects(
    runtime.callRenderer("lab.calls", "bigint"),
    refusedWith("PLUGIN_CALL_UNSERIALIZABLE", /not JSON/),
  );
  await assert.rejects(
    runtime.callRenderer("lab.calls", "shutdown"),
    refusedWith("PLUGIN_CALL_NO_HANDLER"),
    "an undeclared method never reaches the plugin",
  );
  assert.deepEqual(await runtime.callRenderer("lab.calls", "echo"), { method: "echo", args: {} });

  // The relay does not wait past 2s for a plugin that never answers.
  const started = Date.now();
  await assert.rejects(
    runtime.callRenderer("lab.calls", "silent"),
    refusedWith("PLUGIN_CALL_TIMEOUT", /within 2000ms/),
  );
  assert.ok(Date.now() - started >= 1_900, "the timeout is the relay's 2s");

  await runtime.unload("lab.calls");
  await assert.rejects(runtime.callRenderer("lab.calls", "echo"), refusedWith("PLUGIN_UNLOADED"));
});

test("a plugin without onRendererCall answers every declared method with NO_HANDLER", async (t) => {
  const runtime = runtimeFor(t);
  await runtime.loadFromPath(
    writePlugin(t, { id: "lab.mute", main: "module.exports = { onLoad() {} };\n" }),
    ["renderer.extension"],
  );
  await assert.rejects(
    runtime.callRenderer("lab.mute", "echo", {}),
    refusedWith("PLUGIN_CALL_NO_HANDLER", /does not implement onRendererCall/),
  );
});

test("without the renderer.extension grant the plugin runs but has no renderer extension", async (t) => {
  const runtime = runtimeFor(t);
  const dir = writePlugin(t, { id: "lab.ungranted" });
  await runtime.loadFromPath(dir, []);
  assert.ok(runtime.getLoaded("lab.ungranted"), "the headless entry still runs");
  assert.equal(runtime.rendererDescriptor("lab.ungranted"), undefined);
  await assert.rejects(
    runtime.callRenderer("lab.ungranted", "echo", {}),
    refusedWith("PLUGIN_UNLOADED"),
  );
  // No generation was ever handed out, so there is none to guess.
  for (let generation = 1; generation < 64; generation += 1) {
    assert.equal(runtime.resolveRendererSource("lab.ungranted", generation, "renderer/index.js"), null);
  }
});
