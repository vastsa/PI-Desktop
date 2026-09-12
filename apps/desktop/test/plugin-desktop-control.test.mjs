import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "../electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => { if (child.connected) child.send(message); },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin(id, permissions, main) {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-control-plugin-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    version: "0.0.1",
    main: "main.js",
    permissions,
  }), "utf8");
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

function createRuntime(t, calls, extraServices = {}) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    desktopControl: {
      operations: [
        { id: "project/set", channel: "projectSet", description: "Open a project", risk: "write" },
        { id: "session/delete", channel: "sessionDelete", description: "Delete a session", risk: "dangerous" },
      ],
      invoke: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    },
    ...extraServices,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return runtime;
}

const DANGEROUS_PLUGIN = `
  module.exports = {
    onPanelInvoke: async (channel, payload) => {
      try {
        return { ok: true, result: await pi.desktop.invoke({ operation: "session/delete", args: ["s1"], confirm: payload?.confirm !== false }) };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    },
  };
`;

test("dangerous desktop operations are refused without a host consent service", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls);
  const dir = writePlugin("demo.dangerous.headless", ["desktop.control"], DANGEROUS_PLUGIN);
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const result = await runtime.invokePanelBridge("demo.dangerous.headless", "desktop.test", {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "PERMISSION_DENIED");
  assert.deepEqual(calls, [], "the controller must never see an unconfirmed dangerous call");
});

test("dangerous desktop operations need the user's native consent, not just confirm=true", async (t) => {
  const calls = [];
  const prompts = [];
  let answer = false;
  const runtime = createRuntime(t, calls, {
    confirmDesktopControl: async (request) => {
      prompts.push(request);
      return answer;
    },
  });
  const dir = writePlugin("demo.dangerous", ["desktop.control"], DANGEROUS_PLUGIN);
  await runtime.loadFromPath(dir, ["desktop.control"]);

  const declined = await runtime.invokePanelBridge("demo.dangerous", "desktop.test", {});
  assert.equal(declined.ok, false);
  assert.equal(declined.code, "PERMISSION_DENIED");
  assert.deepEqual(calls, []);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].pluginId, "demo.dangerous");
  assert.equal(prompts[0].operation, "session/delete");
  assert.equal(prompts[0].description, "Delete a session");
  assert.deepEqual(prompts[0].args, ["s1"]);

  answer = true;
  const granted = await runtime.invokePanelBridge("demo.dangerous", "desktop.test", {});
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.deepEqual(calls, [{ operation: "session/delete", args: ["s1"], confirm: true }]);

  // A plugin that does not even acknowledge the risk never reaches the user.
  const unacknowledged = await runtime.invokePanelBridge("demo.dangerous", "desktop.test", { confirm: false });
  assert.equal(unacknowledged.code, "CONFIRMATION_REQUIRED");
  assert.equal(prompts.length, 2, "no consent prompt for an unacknowledged call");
});

test("desktop control is permission-gated and uses the shared controller", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls);
  const dir = writePlugin("demo.desktop", ["desktop.control"], `
    module.exports = {
      onPanelInvoke: async () => ({
        operations: await pi.desktop.listOperations(),
        result: await pi.desktop.invoke({ operation: "project/set", args: ["/tmp/project"] }),
      }),
    };
  `);
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const result = await runtime.invokePanelBridge("demo.desktop", "desktop.test");
  assert.deepEqual(result.operations, [
    { id: "project/set", description: "Open a project", risk: "write" },
    { id: "session/delete", description: "Delete a session", risk: "dangerous" },
  ]);
  assert.deepEqual(calls, [{ operation: "project/set", args: ["/tmp/project"], confirm: false }]);
});

test("desktop control fails closed without its permission", async (t) => {
  const runtime = createRuntime(t, []);
  const dir = writePlugin("demo.denied", [], `
    module.exports = {
      onPanelInvoke: async () => pi.desktop.listOperations(),
    };
  `);
  await runtime.loadFromPath(dir, []);
  await assert.rejects(
    () => runtime.invokePanelBridge("demo.denied", "desktop.test"),
    (error) => error.code === "PERMISSION_DENIED",
  );
});
