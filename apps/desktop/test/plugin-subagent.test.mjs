import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Plugin-started subagents (`agent.subagent`, issue #2508): permission gate,
// invocation-bound identity, id ownership, wait bounds, and audit hygiene.

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const SECRET_TASK = "TOP-SECRET-BRIEF: refactor the billing module";

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

/**
 * One tool, `orchestrate`, runs `pi.agent[op](input)` and returns the result
 * or the error code, so each test drives the API through a real tool call.
 * A command runs the same call outside any tool invocation.
 */
function writePlugin({ id, permissions }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "main.js"),
    `
      const run = async ({ op, input }) => {
        try {
          return { ok: true, value: await pi.agent[op](input) };
        } catch (error) {
          return { ok: false, code: error.code, message: error.message };
        }
      };
      module.exports = {
        async onLoad() {
          await pi.agent.registerTool({
            name: "orchestrate",
            description: "orchestrate",
            schema: { type: "object", properties: {} },
            execute: async (args) => run(args),
          });
          if (${JSON.stringify(id === "demo.orchestrator")}) {
            await pi.commands.register({
              id: "outside",
              title: "Outside",
              run: async () => {
                await pi.agent.startSubagent({ agent: "explorer", task: "x" });
              },
            });
          }
        },
      };
    `,
    "utf8",
  );
  return dir;
}

function fakeSidecar() {
  const calls = { start: [], wait: [], stop: [] };
  const known = new Map();
  let next = 0;
  return {
    calls,
    known,
    services: {
      start: async (input) => {
        calls.start.push(input);
        next += 1;
        const delegationId = `d${next}`;
        known.set(delegationId, "running");
        return { delegationId, agent: input.agent, modelId: "prov/model" };
      },
      wait: async (input) => {
        calls.wait.push(input);
        const unknown = input.delegationIds.filter((id) => !known.has(id));
        if (unknown.length) return { results: [], running: [], unknown };
        const results = [];
        const running = [];
        for (const id of input.delegationIds) {
          if (known.get(id) === "running") running.push(id);
          else results.push({ delegationId: id, agent: "explorer", status: "completed", modelId: "prov/model", report: `report ${id}`, turns: 1, toolCalls: 2 });
        }
        return { results, running, unknown: [] };
      },
      stop: async (input) => {
        calls.stop.push(input);
        for (const id of input.delegationIds) known.set(id, "stopped");
        return { pending: [], stopped: input.delegationIds };
      },
    },
  };
}

async function setup(t, { permissions = ["agent.tool.register", "agent.subagent"], ids = ["demo.orchestrator"] } = {}) {
  const sidecar = fakeSidecar();
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    subagents: sidecar.services,
    audit: (entry) => audits.push(entry),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  for (const id of ids) await runtime.loadFromPath(writePlugin({ id, permissions }), permissions);
  const tool = (pluginId = ids[0]) =>
    runtime.getTools().find((entry) => entry.pluginId === pluginId && entry.name === "orchestrate");
  const call = (op, input, ctx = {}, pluginId = ids[0]) =>
    tool(pluginId).execute(
      { op, input },
      { sessionId: "s1", turnId: "t1", toolCallId: "call-1", ...ctx },
    );
  return { runtime, sidecar, audits, call };
}

test("agent.subagent is required", async (t) => {
  const { sidecar, call } = await setup(t, { permissions: ["agent.tool.register"] });
  for (const op of ["startSubagent", "waitSubagents", "stopSubagents"]) {
    const output = await call(op, { agent: "explorer", task: "x" });
    assert.equal(output.ok, false);
    assert.equal(output.code, "PERMISSION_DENIED");
  }
  assert.equal(sidecar.calls.start.length + sidecar.calls.wait.length + sidecar.calls.stop.length, 0);
});

test("starting a subagent is refused outside a tool invocation", async (t) => {
  const { runtime, sidecar } = await setup(t);
  const outside = runtime.getCommands().find((command) => command.id === "outside");
  await assert.rejects(() => outside.run(), /only available during tool execution/);
  assert.equal(sidecar.calls.start.length, 0);
});

test("session, turn and parent tool call come from the invocation, not the arguments", async (t) => {
  const { sidecar, call } = await setup(t);
  const output = await call("startSubagent", {
    agent: "explorer",
    task: "Find it.",
    description: "find",
    model: "prov/model",
    sessionId: "forged-session",
    turnId: "forged-turn",
    toolCallId: "forged-call",
  });
  assert.deepEqual(output, { ok: true, value: { delegationId: "d1", agent: "explorer", modelId: "prov/model" } });
  assert.deepEqual(sidecar.calls.start, [
    {
      sessionId: "s1",
      turnId: "t1",
      toolCallId: "call-1",
      agent: "explorer",
      task: "Find it.",
      description: "find",
      model: "prov/model",
    },
  ]);
  // A dispatch without turn identity is not a live tool call to delegate from.
  const noTurn = await call("startSubagent", { agent: "explorer", task: "x" }, { turnId: undefined });
  assert.equal(noTurn.code, "INVALID_ARGUMENT");
  assert.equal(sidecar.calls.start.length, 1);
});

test("validates start input before reaching the sidecar", async (t) => {
  const { sidecar, call } = await setup(t);
  for (const input of [
    { task: "x" },
    { agent: "explorer", task: "" },
    { agent: "explorer", task: "x".repeat(100_001) },
    { agent: "explorer", task: "x", model: 7 },
    "explorer",
  ]) {
    const output = await call("startSubagent", input);
    assert.equal(output.code, "INVALID_ARGUMENT", JSON.stringify(input).slice(0, 60));
  }
  assert.equal(sidecar.calls.start.length, 0);
});

test("only the starting plugin may wait on or stop its delegations", async (t) => {
  const { sidecar, call } = await setup(t, { ids: ["demo.orchestrator", "demo.other"] });
  const started = await call("startSubagent", { agent: "explorer", task: "x" });
  const id = started.value.delegationId;

  for (const op of ["waitSubagents", "stopSubagents"]) {
    const foreign = await call(op, { delegationIds: [id] }, {}, "demo.other");
    assert.equal(foreign.code, "PERMISSION_DENIED", op);
    // Same plugin, another session: also not its delegation.
    const otherSession = await call(op, { delegationIds: [id] }, { sessionId: "s2" });
    assert.equal(otherSession.code, "PERMISSION_DENIED", op);
  }
  // A plugin with nothing of its own never forwards an empty id list, which
  // the runtime would read as "every running delegation".
  assert.deepEqual(await call("waitSubagents", {}, {}, "demo.other"), { ok: true, value: { results: [], running: [] } });
  assert.deepEqual(await call("stopSubagents", {}, {}, "demo.other"), { ok: true, value: { stopped: [] } });
  assert.equal(sidecar.calls.wait.length, 0);
  assert.equal(sidecar.calls.stop.length, 0);

  // Ownership survives across tool invocations of the same plugin.
  sidecar.known.set(id, "completed");
  const waited = await call("waitSubagents", { delegationIds: [id] }, { turnId: "t2", toolCallId: "call-2" });
  assert.equal(waited.value.results[0].report, `report ${id}`);
  assert.equal(sidecar.calls.wait[0].toolCallId, "call-2");
});

test("waits default to unreceived delegations and enforce timeout bounds", async (t) => {
  const { sidecar, call } = await setup(t);
  const first = (await call("startSubagent", { agent: "explorer", task: "one" })).value.delegationId;
  const second = (await call("startSubagent", { agent: "explorer", task: "two" })).value.delegationId;

  for (const timeoutSeconds of [0, 91, "60", Number.NaN]) {
    const output = await call("waitSubagents", { timeoutSeconds });
    assert.equal(output.code, "INVALID_ARGUMENT", String(timeoutSeconds));
  }
  assert.equal((await call("waitSubagents", { mode: "first" })).code, "INVALID_ARGUMENT");
  const tooMany = Array.from({ length: 33 }, (_, i) => `x${i}`);
  assert.equal((await call("waitSubagents", { delegationIds: tooMany })).code, "INVALID_ARGUMENT");
  assert.equal(sidecar.calls.wait.length, 0);

  sidecar.known.set(first, "completed");
  const any = await call("waitSubagents", { mode: "any", timeoutSeconds: 90 });
  assert.deepEqual(any.value.running, [second]);
  assert.deepEqual(any.value.results.map((result) => result.delegationId), [first]);
  assert.deepEqual(sidecar.calls.wait[0], {
    sessionId: "s1",
    delegationIds: [first, second],
    mode: "any",
    timeoutMs: 90_000,
    toolCallId: "call-1",
  });

  // `first` was received; the default target set is now only `second`.
  await call("waitSubagents", {});
  assert.deepEqual(sidecar.calls.wait[1].delegationIds, [second]);
  assert.equal(sidecar.calls.wait[1].timeoutMs, 60_000);
  assert.equal(sidecar.calls.wait[1].mode, "all");

  const stopped = await call("stopSubagents", {});
  assert.deepEqual(stopped.value, { stopped: [second] });
  assert.deepEqual(sidecar.calls.stop, [{ sessionId: "s1", delegationIds: [second] }]);
});

test("ids the runtime no longer knows are NOT_FOUND, and unload ends ownership", async (t) => {
  const { runtime, sidecar, call } = await setup(t);
  const id = (await call("startSubagent", { agent: "explorer", task: "x" })).value.delegationId;
  sidecar.known.delete(id); // the session runtime was disposed
  assert.equal((await call("waitSubagents", { delegationIds: [id] })).code, "NOT_FOUND");

  const kept = (await call("startSubagent", { agent: "explorer", task: "y" })).value.delegationId;
  await runtime.unload("demo.orchestrator");
  const dir = writePlugin({ id: "demo.orchestrator", permissions: ["agent.tool.register", "agent.subagent"] });
  await runtime.loadFromPath(dir, ["agent.tool.register", "agent.subagent"]);
  assert.equal((await call("waitSubagents", { delegationIds: [kept] })).code, "PERMISSION_DENIED");
});

test("audit records counts and outcomes, never the task text", async (t) => {
  const { audits, call } = await setup(t);
  await call("startSubagent", { agent: "explorer", task: SECRET_TASK });
  await call("startSubagent", { agent: "explorer", task: SECRET_TASK, model: 3 });
  await call("waitSubagents", { timeoutSeconds: 1 });
  const subagentAudits = audits.filter((entry) => String(entry.api).includes("Subagent"));
  assert.deepEqual(
    subagentAudits.map(({ api, ok, errorCode }) => ({ api, ok, errorCode })),
    [
      { api: "agent.startSubagent", ok: true, errorCode: undefined },
      { api: "agent.startSubagent", ok: false, errorCode: "INVALID_ARGUMENT" },
      { api: "agent.waitSubagents", ok: true, errorCode: undefined },
    ],
  );
  assert.equal(subagentAudits[0].taskChars, SECRET_TASK.length);
  assert.equal(subagentAudits[0].pluginId, "demo.orchestrator");
  assert.ok(!JSON.stringify(audits).includes("TOP-SECRET"));
});
