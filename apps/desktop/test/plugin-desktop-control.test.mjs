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
        { id: "session/create", channel: "sessionCreate", description: "Create a durable session", risk: "write" },
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
  assert.deepEqual(calls, [{ operation: "session/delete", args: ["s1"], confirm: true, source: "plugin", pluginContext: { pluginId: "demo.dangerous" } }]);

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
    { id: "session/create", description: "Create a durable session", risk: "write" },
    { id: "session/delete", description: "Delete a session", risk: "dangerous" },
  ]);
  assert.deepEqual(calls, [{ operation: "project/set", args: ["/tmp/project"], confirm: false, source: "plugin", pluginContext: { pluginId: "demo.desktop" } }]);
});

test("permission inheritance is bound to the current plugin tool session", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls);
  const dir = writePlugin("demo.inheritance", ["agent.tool.register", "desktop.control"], `
    module.exports = {
      onLoad: async () => pi.agent.registerTool({
        name: "create_worker",
        description: "Create a worker",
        risk: "high",
        schema: { type: "object" },
        execute: async () => pi.desktop.invoke({
          operation: "session/create",
          args: [{ inheritPermissionFromSessionId: "parent" }],
        }),
      }),
    };
  `);
  await runtime.loadFromPath(dir, ["agent.tool.register", "desktop.control"]);
  const tool = runtime.getTools().find((entry) => entry.name === "create_worker");
  assert.ok(tool);

  await assert.rejects(
    tool.execute({}, { sessionId: "other" }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.deepEqual(calls, []);

  await tool.execute({}, { sessionId: "parent" });
  assert.equal(typeof calls[0].pluginContext.invocationId, "string");
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.deepEqual(calls, [
    {
      operation: "session/create",
      args: [{ inheritPermissionFromSessionId: "parent" }],
      confirm: false,
      source: "plugin",
      pluginContext: { pluginId: "demo.inheritance", sessionId: "parent", invocationId: calls[0].pluginContext.invocationId },
      signal: calls[0].signal,
    },
  ]);
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

test("model-only grants must be declared and approved in addition to desktop control", async (t) => {
  const calls = [];
  const prompts = [];
  const runtime = createRuntime(t, calls, {
    desktopControl: {
      operations: [
        { id: "session/configureModel", channel: "model", description: "Select a session model", risk: "write" },
        { id: "session/configure", channel: "config", description: "Configure a session", risk: "dangerous" },
      ],
      invoke: async (input) => { calls.push(input); return { session: { id: input.args[0], ...input.args[1] } }; },
    },
    confirmDesktopControl: async (request) => { prompts.push(request); return false; },
  });
  const source = `module.exports = { onPanelInvoke: async (channel, payload) => {
    if (channel === "list") return pi.desktop.listOperations();
    try { return { ok: true, value: await pi.desktop.invoke(payload) }; }
    catch (error) { return { ok: false, code: error.code }; }
  } };`;
  const oldPath = writePlugin("demo.model.old", ["desktop.control"], source);
  await runtime.loadFromPath(oldPath, ["desktop.control"]);
  assert.deepEqual((await runtime.invokePanelBridge("demo.model.old", "list")).map((op) => op.id), ["session/configure"]);
  const request = { operation: "session/configureModel", args: ["s2", { providerId: "p", modelId: "m" }] };
  assert.equal((await runtime.invokePanelBridge("demo.model.old", "run", request)).code, "PERMISSION_DENIED");
  const newPath = writePlugin("demo.model.new", ["desktop.control", "session.model.configure"], source);
  await runtime.loadFromPath(newPath, ["desktop.control"]);
  assert.equal((await runtime.invokePanelBridge("demo.model.new", "run", request)).code, "PERMISSION_DENIED");
  await runtime.unload("demo.model.new");
  await runtime.loadFromPath(newPath, ["desktop.control", "session.model.configure"]);
  assert.deepEqual((await runtime.invokePanelBridge("demo.model.new", "list")).map((op) => op.id), ["session/configureModel", "session/configure"]);
  const selected = await runtime.invokePanelBridge("demo.model.new", "run", request);
  assert.deepEqual(selected.value.session, { id: "s2", providerId: "p", modelId: "m" });
  assert.equal(prompts.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pluginContext.pluginId, "demo.model.new");
  assert.equal((await runtime.invokePanelBridge("demo.model.new", "run", {
    operation: "session/configure", args: ["s2", { mode: "agent", permissionMode: "auto" }], confirm: true,
  })).code, "PERMISSION_DENIED");
  assert.equal(prompts.length, 1);
  assert.equal(calls.length, 1);
});
