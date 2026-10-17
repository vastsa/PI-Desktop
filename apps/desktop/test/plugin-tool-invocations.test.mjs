import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginToolInvocations } = await import("../electron/main/plugin-tool-invocations.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("invocation IDs cannot cross plugin processes or survive settlement", async () => {
  const registry = new PluginToolInvocations();
  const owner = {};
  const invocation = registry.begin(owner, { pluginId: "p", sessionId: "s", toolName: "probe", turnId: "t" });
  await assert.rejects(registry.run({}, invocation.id, async () => {}), { code: "PLUGIN_TOOL_ABORTED" });
  await assert.rejects(registry.run(owner, "invented", async () => {}), { code: "PLUGIN_TOOL_ABORTED" });
  assert.equal(await registry.run(owner, invocation.id, async () => registry.current(owner)?.sessionId), "s");
  assert.equal(await registry.run(owner, undefined, async () => registry.current(owner)), undefined);
  registry.finish(invocation);
  await assert.rejects(registry.run(owner, invocation.id, async () => {}), { code: "PLUGIN_TOOL_ABORTED" });
});

test("canceling one session rejects pending host work while sibling context remains valid", async () => {
  const registry = new PluginToolInvocations();
  const owner = {};
  const first = registry.begin(owner, { pluginId: "p", sessionId: "a", toolName: "probe" });
  const second = registry.begin(owner, { pluginId: "p", sessionId: "b", toolName: "probe" });
  const pending = registry.run(owner, first.id, async () => new Promise(() => {}));
  const rejected = assert.rejects(pending, { code: "PLUGIN_TOOL_ABORTED" });
  registry.cancelSession("a", "Stopped by user");
  await rejected;
  assert.equal(await registry.run(owner, second.id, async () => registry.current(owner)?.sessionId), "b");
  registry.cancelOwner(owner, "Plugin unloaded");
  assert.equal(second.signal.aborted, true);
});

const PLUGIN = `
  const aborted = new Set();
  module.exports = {
    onLoad: async () => pi.agent.registerTool({
      name: "probe", description: "Probe invocation isolation", schema: { type: "object" },
      execute: async (args, ctx) => {
        ctx.signal.addEventListener("abort", () => aborted.add(ctx.sessionId), { once: true });
        await pi.desktop.invoke({ operation: "session/get", args: [ctx.sessionId] });
        if (args.reveal) await pi.browser.reveal();
        if (args.wait) {
          return new Promise((resolve) => {
            const finish = () => { aborted.add(ctx.sessionId); resolve({ aborted: true }); };
            if (ctx.signal.aborted) finish();
            else ctx.signal.addEventListener("abort", finish, { once: true });
          });
        }
        const context = await pi.session.getLlmContext();
        const created = await pi.desktop.invoke({ operation: "session/create", args: [{ inheritPermissionFromSessionId: ctx.sessionId }] });
        return { sessionId: ctx.sessionId, turnId: ctx.turnId, hasSignal: !!ctx.signal, context, created };
      },
    }),
    onPanelInvoke: async (channel, payload) => {
      if (channel === "probe.aborted") return aborted.has(payload.sessionId);
      if (channel === "probe.desktop") return pi.desktop.invoke({ operation: "session/get", args: ["panel"] });
      try { return await pi.session.getLlmContext(); }
      catch (error) { return { code: error.code }; }
    },
  };
`;

async function fixture(t, onInvoke) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-invocations-"));
  const id = "demo.invocations";
  const permissions = ["agent.tool.register", "browser.cdp", "desktop.control", "session.read"];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name: id, version: "0.0.1", main: "main.js", permissions,
  }));
  writeFileSync(join(dir, "main.js"), PLUGIN);
  const calls = [];
  const reveals = [];
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    desktopControl: {
      operations: [{ id: "session/get", risk: "read" }, { id: "session/create", risk: "write" }],
      async invoke(input) { calls.push(input); return onInvoke(input); },
    },
    browser: {
      async reveal(sessionId) { reveals.push(sessionId); },
    },
    getSessionContext: async (sessionId) => ({ sessionId, messages: [], truncated: false }),
  });
  t.after(async () => { await runtime.unload(id); rmSync(dir, { recursive: true, force: true }); });
  await runtime.loadFromPath(dir, permissions);
  const tool = runtime.getTools().find((entry) => entry.name === "probe");
  assert.ok(tool);
  return { id, runtime, tool, calls, reveals };
}

test("browser.reveal reaches Main with the invoking session context", { timeout: 5000 }, async (t) => {
  const { tool, reveals } = await fixture(t, async () => ({}));
  const result = await tool.execute({ reveal: true }, { sessionId: "session-b", turnId: "turn-b" });
  assert.equal(result.sessionId, "session-b");
  assert.deepEqual(reveals, ["session-b"]);
});

test("real plugin calls keep sender identity through concurrent out-of-order completion", { timeout: 5000 }, async (t) => {
  const enteredA = deferred();
  const enteredB = deferred();
  const releaseA = deferred();
  const releaseB = deferred();
  const { id, runtime, tool, calls } = await fixture(t, async (input) => {
    if (input.operation === "session/get" && input.args[0] === "a") { enteredA.resolve(); await releaseA.promise; }
    if (input.operation === "session/get" && input.args[0] === "b") { enteredB.resolve(); await releaseB.promise; }
    return { sender: input.pluginContext.sessionId };
  });
  const first = tool.execute({}, { sessionId: "a", turnId: "turn-a" });
  await enteredA.promise;
  const second = tool.execute({}, { sessionId: "b", turnId: "turn-b" });
  await enteredB.promise;
  assert.deepEqual(await runtime.invokePanelBridge(id, "probe.context"), { code: "INVALID_ARGUMENT" });
  await runtime.invokePanelBridge(id, "probe.desktop");
  assert.deepEqual(calls.find((input) => input.args[0] === "panel").pluginContext, { pluginId: id });
  releaseA.resolve();
  const a = await first;
  assert.equal(a.context.sessionId, "a");
  assert.equal(a.created.sender, "a");
  assert.equal(a.turnId, "turn-a");
  assert.equal(a.hasSignal, true);
  releaseB.resolve();
  const b = await second;
  assert.equal(b.context.sessionId, "b");
  assert.equal(b.created.sender, "b");
  assert.equal(b.turnId, "turn-b");
  const starts = calls.filter((input) => input.operation === "session/create");
  assert.notEqual(starts[0].pluginContext.invocationId, starts[1].pluginContext.invocationId);
});

test("session cancellation reaches the child AbortSignal and leaves sibling invocations running", { timeout: 5000 }, async (t) => {
  const started = new Map([["a", deferred()], ["b", deferred()]]);
  const { id, runtime, tool } = await fixture(t, async (input) => {
    started.get(input.args[0])?.resolve();
    return {};
  });
  const a = tool.execute({ wait: true }, { sessionId: "a", turnId: "turn-a" });
  const b = tool.execute({ wait: true }, { sessionId: "b", turnId: "turn-b" });
  const rejectedA = assert.rejects(a, { code: "PLUGIN_TOOL_ABORTED" });
  const rejectedB = assert.rejects(b, { code: "PLUGIN_TOOL_ABORTED" });
  await Promise.all([...started.values()].map((entry) => entry.promise));
  runtime.cancelSessionTools("a");
  await rejectedA;
  assert.equal(await runtime.invokePanelBridge(id, "probe.aborted", { sessionId: "a" }), true);
  assert.equal(await runtime.invokePanelBridge(id, "probe.aborted", { sessionId: "b" }), false);
  runtime.cancelSessionTools("b");
  await rejectedB;
});

test("parent AbortSignal and plugin unload both revoke active invocations", { timeout: 5000 }, async (t) => {
  let started = deferred();
  const { id, runtime, tool } = await fixture(t, async () => { started.resolve(); return {}; });
  const controller = new AbortController();
  const pending = tool.execute({ wait: true }, { sessionId: "a", signal: controller.signal });
  const rejected = assert.rejects(pending, /parent cancelled/);
  await started.promise;
  controller.abort(new Error("parent cancelled"));
  await rejected;
  assert.equal(await runtime.invokePanelBridge(id, "probe.aborted", { sessionId: "a" }), true);
  started = deferred();
  const unloading = tool.execute({ wait: true }, { sessionId: "b" });
  const rejectedUnload = assert.rejects(unloading, { code: "PLUGIN_TOOL_ABORTED" });
  await started.promise;
  await runtime.unload(id);
  await rejectedUnload;
  await assert.rejects(tool.execute({}, { sessionId: "c" }), { code: "NOT_FOUND" });
});

test("the tool deadline aborts child work and revokes its invocation", { timeout: 5000 }, async (t) => {
  const started = deferred();
  const { id, runtime, tool } = await fixture(t, async () => { started.resolve(); return {}; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = tool.execute({ wait: true }, { sessionId: "a" });
  const rejected = assert.rejects(pending, { code: "TIMEOUT" });
  await started.promise;
  t.mock.timers.tick(110_000);
  await rejected;
  t.mock.timers.reset();
  assert.equal(await runtime.invokePanelBridge(id, "probe.aborted", { sessionId: "a" }), true);
});
