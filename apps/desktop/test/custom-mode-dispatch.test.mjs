import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { modeAfterPlanningUpdate } = await import("../src/stores/helpers/planning-projection.ts");
const { IPC } = await import("@pi-desktop/shared");

async function promptFixture({ unavailable = false, prepared } = {}) {
  const handlers = new Map();
  const prompts = [];
  const definition = {
    version: 1, id: "review", label: "Review", description: "", source: "user",
    permission: "contract", prompt: "Review without changing files.",
    returnTo: "agent", artifacts: [], stages: [],
    budget: { maxTurns: 20, maxTokens: null },
  };
  const hostCalls = [];
  const host = { async call(method) {
    hostCalls.push(method);
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: "s", mode: "review", messages: [] } };
    if (method === "session.beginTurn") return { turnId: "turn" };
    if (method === "session.appendMessage") return {};
    assert.fail(`unexpected Host method ${method}`);
  } };
  const sidecar = {
    setProjectInstructionRoot() {},
    async call(method, params) {
      assert.equal(method, "agent.prompt");
      prompts.push(params);
      return { accepted: true, turnId: "turn" };
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    modeRuns: {
      definitionForPrompt: async id => {
        assert.equal(id, "review");
        if (unavailable) throw Object.assign(new Error("Mode is not available"), { errorCode: "MODE_NOT_FOUND" });
        return definition;
      },
      prepareTurn: async () => prepared,
    },
    getHost: () => host, getSidecar: () => sidecar, getAgentHostBridge: () => null,
    logger: { app() {} }, persistenceOutbox: {}, dataDir: "/unused-no-attachments",
    activeTurns: new Map(), activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart() {}, acquireSessionOperation: async () => () => {},
    resolveAgentRuntimeLaunch: async () => ({
      providerId: "fixture", modelId: "fixture",
      sidecarParams: { sessionId: "s", mode: "review", provider: { modelConfig: { input: ["text"] } } },
    }),
    finishTurn: async () => assert.fail("prompt admission failed"),
    emitAgentEvent() {}, setNotificationViewingSessionId() {},
  });
  return {
    prompts, hostCalls, definition,
    prompt: () => handlers.get(IPC.invoke.agentPrompt)({ sessionId: "s", content: "Inspect the changes." }),
  };
}

test("a simple custom mode reaches the sidecar with its instructions and policy", async () => {
  const { prompt, prompts, definition } = await promptFixture();
  await prompt();
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].modeDefinition, definition);
  assert.equal(prompts[0].modeTurn, undefined);
});

test("an unavailable mode is rejected before creating a durable turn", async () => {
  const { prompt, prompts, hostCalls } = await promptFixture({ unavailable: true });
  await assert.rejects(prompt, { errorCode: "MODE_NOT_FOUND" });
  assert.equal(prompts.length, 0);
  assert.ok(!hostCalls.includes("session.beginTurn"));
});

test("a staged run keeps its persisted snapshot over the current catalog", async () => {
  const definition = { id: "review", prompt: "Persisted stage instructions." };
  const modeTurn = { runId: "run", stageId: "work", permission: "contract" };
  const { prompt, prompts } = await promptFixture({ prepared: { definition, modeTurn } });
  await prompt();
  assert.deepEqual(prompts[0].modeDefinition, definition);
  assert.deepEqual(prompts[0].modeTurn, modeTurn);
});

test("an inactive Plan projection preserves a custom or staged Goal mode", () => {
  for (const mode of ["review", "goal"]) {
    assert.equal(modeAfterPlanningUpdate(mode, "inactive", () => "agent"), mode);
  }
  assert.equal(modeAfterPlanningUpdate("plan", "inactive", () => "agent"), "agent");
});
