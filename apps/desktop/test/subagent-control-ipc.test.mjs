import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { registerSubagentControlIpc } = await import("../electron/main/ipc/subagent-control-ipc.ts");
const command = (extra = {}) => ({ sessionId: "fixture-session", operationId: "operation-1", action: "start",
  agent: "explorer", task: "Inspect the fixture", ...extra });

function fixture({ mode = "agent", turnId, delivery = "started" } = {}) {
  const calls = []; const handlers = new Map(); const activeTurns = new Map();
  if (turnId) activeTurns.set("fixture-session", turnId);
  const session = { id: "fixture-session", mode, messages: [] };
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "session.get") return { session };
    if (method === "settings.get") return { defaultMode: "agent" };
    if (method === "session.beginTurn") return { turnId: "owned-turn" };
    throw new Error(`Unexpected Host method: ${method}`);
  } };
  const sidecar = {
    async call(method, params) {
      calls.push([method, params]);
      return { accepted: true, operationId: params.request.operationId,
        delegationId: "fixture-delegate", messageId: "user-subagent-operation-1", delivery };
    },
    setProjectInstructionRoot(...args) { calls.push(["instruction-root", args]); },
  };
  const deps = {
    registrar: { handle(channel, handler) { handlers.set(channel, handler); } },
    getHost: () => host, getSidecar: () => sidecar, activeTurns,
    async acquireSessionOperation(id) { calls.push(["acquire", id]); return () => calls.push(["release", id]); },
    recordTurnStart(...args) { calls.push(["turn-start", args]); },
    isTurnDispatchable: (id, expected) => activeTurns.get(id) === expected,
    async resolveAgentRuntimeLaunch(id, detail) { calls.push(["launch", [id, detail]]); return {
      providerId: "host-provider", modelId: "host-model", projectPath: "G:/fixture", sidecarParams: {
        provider: { id: "host-provider", apiKey: "fixture-only-secret" }, mode: "agent", allowedPaths: ["G:/fixture"],
      },
    }; },
    async finishTurn(...args) { calls.push(["finish", args]); },
  };
  registerSubagentControlIpc(deps);
  return { calls, deps, session, invoke: (request) => handlers.get(IPC.invoke.agentSubagentControl)(request) };
}

test("declarative start resolves launch only in Main and never supplies a parent prompt", async () => {
  const f = fixture();
  assert.equal((await f.invoke(command())).delivery, "started");
  const dispatch = f.calls.find(([method]) => method === "agent.controlSubagent")[1];
  assert.equal(dispatch.turnId, "owned-turn");
  assert.deepEqual(dispatch.request, command());
  assert.equal(dispatch.provider.id, "host-provider");
  assert.equal(dispatch.prompt, undefined);
  assert.equal(f.calls.filter(([method]) => method === "session.get")[0][1].messageLimit, 1);
  assert.equal(f.calls.at(-1)[0], "release");
});

test("an active turn receives only the declared command without launching or changing credentials", async () => {
  const f = fixture({ turnId: "active-turn", delivery: "queued" });
  const request = command({ action: "message", delegationId: "fixture-delegate", content: "Change direction" });
  delete request.agent; delete request.task;
  await f.invoke(request);
  const dispatch = f.calls.find(([method]) => method === "agent.controlSubagent")[1];
  assert.deepEqual(dispatch, { sessionId: "fixture-session", turnId: "active-turn", existingTurn: true, request });
  assert.equal(f.calls.some(([method]) => ["launch", "settings.get", "session.beginTurn"].includes(method)), false);
});

test("mode, remote, native and injected launch data are rejected before execution", async () => {
  for (const mode of ["plan", "goal"]) {
    const f = fixture({ mode });
    await assert.rejects(f.invoke(command()), /Agent mode/);
    assert.equal(f.calls.some(([method]) => method === "launch"), false);
  }
  for (const sessionId of ["remote:fixture", "native-pi:fixture"]) {
    const f = fixture();
    await assert.rejects(f.invoke(command({ sessionId })), /unsupported|local/i);
    assert.equal(f.calls.some(([method]) => method === "session.get"), false);
  }
  for (const injected of [{ provider: {} }, { permissions: "auto" }, { tools: ["Bash"] }]) {
    const f = fixture();
    await assert.rejects(f.invoke(command(injected)), /Invalid subagent/);
    assert.equal(f.calls.length, 0);
  }
});

test("a backend change during the authoritative session read cannot dispatch to the old active runtime", async () => {
  const f = fixture({ turnId: "active-turn" });
  const host = f.deps.getHost();
  const original = host.call;
  host.call = async (...args) => {
    const result = await original(...args);
    f.deps.getSidecar = () => null;
    return result;
  };
  await assert.rejects(f.invoke(command()), /changed|unavailable/i);
  assert.equal(f.calls.some(([method]) => method === "agent.controlSubagent"), false);
});

test("a failed owned dispatch finishes only its own turn and releases its operation fence", async () => {
  const f = fixture();
  f.deps.getSidecar().call = async () => { throw Object.assign(new Error("Fixture rejected"), { errorCode: "FIXTURE" }); };
  await assert.rejects(f.invoke(command()), /Fixture rejected/);
  const finish = f.calls.find(([method]) => method === "finish")[1];
  assert.equal(finish[0], "fixture-session");
  assert.equal(finish[1], "error");
  assert.equal(finish[3].turnId, "owned-turn");
  assert.equal(f.calls.at(-1)[0], "release");
});

test("a durable replay settles a newly prepared idle turn without a duplicate provider run", async () => {
  const f = fixture({ delivery: "recorded" });
  await f.invoke(command());
  const finish = f.calls.find(([method]) => method === "finish")[1];
  assert.equal(finish[1], "completed");
  assert.equal(finish[3].createNotification, false);
});
