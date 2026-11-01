import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { goalDispatchContext } = await import("../electron/main/runtime/goal-dispatch.ts");
const { IPC } = await import("@pi-desktop/shared");

function fixture() {
  let goal = null;
  const prompts = [], operations = [];
  const host = { async call(method, params) {
    operations.push(method);
    if (method === "session.get") return { session: { id: "s", title: "Goal", mode: "goal", permissionMode: "ask", createdAt: "", updatedAt: "" } };
    if (method === "session.queueList") return { entries: [] };
    if (method === "goals.get") return { goal: structuredClone(goal) };
    if (method === "goals.start") {
      goal = { id: "g", sessionId: "s", revision: 1, status: "active", objective: params.objective, criteria: [params.objective], progressSummary: "", outcomes: [], budget: params.budget ?? { maxTurns: 20 }, roundsStarted: 0, tokenUsage: 0 };
      return { goal: structuredClone(goal) };
    }
    if (method === "goals.claimTurn") {
      assert.equal(params.expectedRevision, goal.revision);
      assert.equal(goal.activeTurnId, undefined);
      goal.activeTurnId = params.turnId; goal.roundsStarted++; goal.revision++;
      return { goal: structuredClone(goal), claimed: true };
    }
    if (method === "goals.control") {
      assert.equal(params.expectedRevision, goal.revision);
      goal.status = params.action === "cancel" ? "cancelled" : "paused"; goal.revision++;
      return { goal: structuredClone(goal) };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  } };
  const bridge = createAgentHostBridge({ channels: IPC.invoke, getHost: () => host, isSessionBusy: () => false, log() {}, async invoke(channel, [request]) {
    operations.push(channel);
    if (channel === IPC.invoke.agentAbort) return {};
    assert.equal(channel, IPC.invoke.agentPrompt);
    prompts.push(request);
    return { accepted: true, turnId: `runtime-${prompts.length}` };
  } });
  return { bridge, prompts, operations, goal: () => goal };
}

test("Desktop Goal send crosses the real shared admission bridge without approval or permission widening", async () => {
  const f = fixture();
  await f.bridge.goals.start({ sessionId: "s", content: "Verify the fixture", budget: { maxTurns: 3 } });
  assert.equal(f.goal().roundsStarted, 1);
  assert.equal(f.goal().budget.maxTurns, 3);
  const claim = goalDispatchContext(f.prompts[0]);
  assert.equal(claim.provenance, "user-goal");
  assert.equal(claim.goalId, "g");
  assert.equal(f.prompts[0].permissionMode, undefined);
  assert(!f.operations.some(method => method.startsWith("plans.")));
  assert.equal(goalDispatchContext(structuredClone(f.prompts[0])), undefined);
  assert.equal(goalDispatchContext({ ...f.prompts[0], goalTurn: claim }), undefined);
  await f.bridge.goals.control({ sessionId: "s", goalId: "g", expectedRevision: f.goal().revision, action: "pause" });
  assert.equal(f.goal().status, "paused");
  assert(f.operations.indexOf("goals.control") < f.operations.indexOf(IPC.invoke.agentAbort));
});

test("Desktop Goal ingress refuses collaboration/voice/history rewrite without host effects", async () => {
  for (const origin of [{ sessionMessageId: "message" }, { voiceOrigin: { callId: "call", operationId: "op" } }, { truncateBefore: 0 }, { truncateFromMessageId: "message" }]) {
    const f = fixture();
    await assert.rejects(f.bridge.goals.start({ sessionId: "s", content: "work", ...origin }), /direct user objective/);
    assert.equal(f.goal(), null);
    assert.equal(f.prompts.length, 0);
  }
});
