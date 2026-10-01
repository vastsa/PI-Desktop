import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";
import { codexDelegationFeedback, codexWorkFeedbackMessage, parseCodexMessage } from "@pi-desktop/voice-runtime/live";
import { createProductionWorkHarness, settleUntil, WORK_INSTRUCTION, WORK_RESULT, WORK_SESSION_ID } from "./helpers/live-work-production.mjs";

const callId = "live-work-production-call";

test("production Live WorkBridge reaches AgentHost admission, explicit queue, and exact terminal result", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const fixture = await createProductionWorkHarness(t, server);
  const { bridge, agentHostBridge, prompts, persistedMessages, updates, invocationLog } = fixture;
  fixture.openCall(callId);

  async function receive(id, instruction, deliverReceipt = async () => ({ status: "sent", deliveryId: id })) {
    const [event] = parseCodexMessage({
      type: "delegation.created",
      item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text: instruction }] },
    });
    assert.equal(event.kind, "delegation");
    await bridge.receiveCandidate({
      callId, workBindingRevision: 3, workSessionId: WORK_SESSION_ID,
      providerRequestId: event.delegationId, instruction: event.instruction,
    }, deliverReceipt);
  }
  const receiptWire = [];
  await receive("codex-production-request-1", WORK_INSTRUCTION, async (receipt) => {
    receiptWire.push(codexDelegationFeedback("codex-production-request-1", {
      operationId: receipt.operationId, status: "received",
    }));
    return { status: "sent", deliveryId: "codex-receipt-1" };
  });
  assert.equal(prompts.length, 1, "ordinary idle submit reaches the real AgentHost runtime port exactly once");
  assert.equal(prompts[0].content, WORK_INSTRUCTION);
  assert.equal(prompts[0].voiceOrigin.callId, callId);
  assert.equal(typeof prompts[0].messageId, "string");
  assert.equal(persistedMessages[0].id, prompts[0].messageId);
  assert.equal(persistedMessages[0].content, WORK_INSTRUCTION);
  assert.deepEqual(persistedMessages[0].voiceOrigin, prompts[0].voiceOrigin);
  assert.equal(receiptWire.length, 1);
  assert.equal(JSON.parse(receiptWire[0]).type, "delegation.context.append");
  assert.equal(updates.at(-1).operation.execution, "running");

  await receive("codex-production-request-busy", "Add logging to the login flow.");
  assert.equal(prompts.length, 1, "an ordinary submit never silently falls back to Host queue when busy");
  assert.equal(updates.at(-1).operation.admission, "rejected");

  await receive("codex-production-request-queue", "Queue this as an independent follow-up.");
  const queued = agentHostBridge.agentHost.queueEntries(WORK_SESSION_ID);
  assert.equal(queued.length, 1, "explicit independent work is admitted through AgentHost queue");
  assert.equal(queued[0].content, "Queue this as an independent follow-up.");
  assert.equal(queued[0].userMessageId, updates.at(-1).operation.userMessageId);
  assert.equal(queued[0].voiceOrigin.callId, callId);

  fixture.endTurn();
  await settleUntil(() => fixture.results.size === 1 && prompts.length === 2, "terminal result and queued work arrive");
  const terminal = [...fixture.results.values()][0];
  assert.equal(terminal.execution, "completed");
  assert.equal(terminal.resultState, "available");
  assert.equal(terminal.resultSummary, WORK_RESULT);
  assert.ok(fixture.historyReadsAfterTerminal >= 2, "an empty first history read is retried before falling back");
  assert.equal(prompts[1].voiceOrigin.callId, callId);
  assert.equal(agentHostBridge.agentHost.queueEntries(WORK_SESSION_ID).length, 0);
  const resultWire = codexWorkFeedbackMessage("codex-production-request-1", {
    feedbackId: "codex-production-result-1", callId, workBindingRevision: 3,
    operationId: terminal.operationId, kind: "result", delivery: "speak-when-idle", content: terminal.resultSummary,
  });
  assert.match(JSON.parse(resultWire).content[0].text, /The login flow correctly rejects expired credentials/u);
  assert.equal(invocationLog.filter((item) => item.channel === IPC.invoke.agentPrompt).length, 2);
});
