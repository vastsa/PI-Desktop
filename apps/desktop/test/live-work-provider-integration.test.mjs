import assert from "node:assert/strict";
import test from "node:test";
import { AgentHost, MemoryQueueStore } from "@pi-desktop/agent-host";
import { LiveWorkCoordinator } from "@pi-desktop/host-runtime";
import {
  LIVE_WORK_TOOL_NAME,
  codexDelegationFeedback,
  codexWorkFeedbackMessage,
  geminiToolResponseMessage,
  geminiWorkFeedbackMessage,
  parseCodexMessage,
  parseGeminiMessage,
  parseRealtimeMessage,
  realtimeToolReceiptMessage,
  realtimeWorkFeedbackMessages,
} from "@pi-desktop/voice-runtime/live";

const SESSION_ID = "live-work-fixture-session";
const CALL_ID = "live-work-fixture-call";
const BINDING_REVISION = 3;
const INSTRUCTION = "Inspect the login flow and report the verified result.";
const PRINCIPAL = { subject: "desktop", roles: ["owner"], pairedDevice: true };

const profiles = [
  {
    id: "codex-live",
    parse(providerRequestId) {
      const [event] = parseCodexMessage({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: providerRequestId,
          content: [{ type: "input_text", text: INSTRUCTION }],
        },
      });
      assert.equal(event.kind, "delegation");
      return {
        providerRequestId: event.delegationId,
        toolName: LIVE_WORK_TOOL_NAME,
        arguments: { instruction: event.instruction },
      };
    },
    receipt(providerRequestId, receipt) {
      assert.equal(receipt.status, "received");
      return codexDelegationFeedback(providerRequestId, {
        operationId: receipt.operationId,
        status: "received",
      });
    },
    result(providerRequestId, feedback) {
      return codexWorkFeedbackMessage(providerRequestId, feedback);
    },
    assertReceipt(wire, providerRequestId, operationId) {
      const message = JSON.parse(wire);
      assert.equal(message.type, "delegation.context.append");
      assert.equal(message.delegation_item_id, providerRequestId);
      assert.match(message.content[0].text, new RegExp(operationId));
    },
    assertResult(wire, providerRequestId, turnId) {
      const message = JSON.parse(wire);
      assert.equal(message.delegation_item_id, providerRequestId);
      assert.match(message.content[0].text, new RegExp(turnId));
    },
  },
  {
    id: "gemini-live",
    parse(providerRequestId) {
      const [event] = parseGeminiMessage({
        toolCall: {
          functionCalls: [{
            id: providerRequestId,
            name: LIVE_WORK_TOOL_NAME,
            args: { instruction: INSTRUCTION },
          }],
        },
      });
      assert.equal(event.kind, "tool-candidate");
      return event;
    },
    receipt(providerRequestId, receipt) {
      return geminiToolResponseMessage({
        providerRequestId,
        toolName: LIVE_WORK_TOOL_NAME,
        receipt,
      });
    },
    result(_providerRequestId, feedback) {
      return geminiWorkFeedbackMessage(feedback);
    },
    assertReceipt(wire, providerRequestId, operationId) {
      const call = wire.toolResponse.functionResponses[0];
      assert.equal(call.id, providerRequestId);
      assert.equal(call.name, LIVE_WORK_TOOL_NAME);
      assert.deepEqual(call.response, {
        status: "received",
        operationId,
        providerRequestId,
        execution: "not_started",
      });
    },
    assertResult(wire, _providerRequestId, turnId) {
      assert.match(wire.clientContent.turns[0].parts[0].text, new RegExp(turnId));
    },
  },
  ...["realtime-ga", "realtime-compat-v1"].map((id) => ({
    id,
    parse(providerRequestId) {
      const [event] = parseRealtimeMessage({
        type: "response.function_call_arguments.done",
        call_id: providerRequestId,
        name: LIVE_WORK_TOOL_NAME,
        arguments: JSON.stringify({ instruction: INSTRUCTION }),
      }, id);
      assert.equal(event.kind, "tool-candidate");
      return event;
    },
    receipt(providerRequestId, receipt) {
      return realtimeToolReceiptMessage({ providerRequestId, receipt });
    },
    result(_providerRequestId, feedback) {
      return realtimeWorkFeedbackMessages(feedback);
    },
    assertReceipt(wire, providerRequestId, operationId) {
      assert.equal(wire.item.type, "function_call_output");
      assert.equal(wire.item.call_id, providerRequestId);
      assert.deepEqual(JSON.parse(wire.item.output), {
        status: "received",
        operationId,
        providerRequestId,
        execution: "not_started",
      });
    },
    assertResult(wire, _providerRequestId, turnId) {
      assert.match(wire[0].item.content[0].text, new RegExp(turnId));
      assert.deepEqual(wire[1], { type: "response.create" });
    },
  })),
];

for (const profile of profiles) {
  test(`${profile.id} request reaches AgentHost admission and terminal feedback wire`, async (t) => {
    const prompts = [];
    let id = 0;
    const host = new AgentHost({
      runtime: {
        async prompt(request) {
          prompts.push(request);
          id += 1;
          return { turnId: `runtime-turn-${id}` };
        },
        async steer() { return { accepted: true }; },
        async stop() { return { requested: true }; },
        async abort() {},
        async respondInput() {},
      },
      sessions: {
        async get(sessionId) {
          return {
            id: sessionId,
            title: "Live work fixture",
            projectId: "fixture-project",
            mode: "agent",
            permissionMode: "ask",
            createdAt: "2026-09-29T00:00:00.000Z",
            updatedAt: "2026-09-29T00:00:00.000Z",
          };
        },
        async history() { return { items: [], hasMore: false }; },
      },
      approvals: {
        async resolveTool() {},
        async resolveContract() {},
        async listPendingTools() { return []; },
      },
      clock: { now: () => Date.parse("2026-09-29T00:00:00.000Z") },
      ids: { next: (prefix) => `${prefix}-${++id}` },
      queueStore: new MemoryQueueStore(),
    });

    const updates = [];
    const coordinator = new LiveWorkCoordinator({
      resolveIntent: async () => ({
        kind: "new-task",
        relationToActive: "unspecified",
        explicitRepeat: false,
      }),
      workPort: {
        async snapshot(sessionId) {
          const state = await host.workSnapshot(sessionId);
          return {
            sessionId,
            mode: state.mode,
            state: state.state,
            ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
            queue: state.queue.map(({ queueEntryId, position }) => ({ queueEntryId, position, summary: "" })),
            observedAt: Date.parse("2026-09-29T00:00:00.000Z"),
          };
        },
        observeTurnTarget(sessionId) {
          return host.observeWorkTarget(sessionId).activeTurnId;
        },
        async lookupAdmission() {
          return { kind: "not-found" };
        },
        async submit(request) {
          const result = await host.startTurn(PRINCIPAL, {
            sessionId: request.sessionId,
            admission: "queue",
            idempotencyKey: request.idempotencyKey,
            input: {
              text: request.text,
              userMessageId: request.userMessageId,
              voiceOrigin: request.voiceOrigin,
            },
            context: { requestId: request.idempotencyKey },
          });
          return result.turn.status === "queued"
            ? { status: "queued", queueEntryId: result.turn.id }
            : { status: "started", turnId: result.turn.id };
        },
        async steer() { return { accepted: true }; },
        async enqueue() { return { queueEntryId: "unused-queue-entry" }; },
        async stop() { return { status: "requested" }; },
        async cancelQueued() { return { status: "canceled" }; },
        async listProjects() { return []; },
        async listSessions() { return []; },
        async openSelection() { return { status: "opened" }; },
      },
      onOperation: (update) => updates.push(update),
      now: () => Date.parse("2026-09-29T00:00:00.000Z"),
    });
    t.after(() => coordinator.closeCall(CALL_ID));

    coordinator.openCall({
      callId: CALL_ID,
      workSessionId: SESSION_ID,
      workBindingRevision: BINDING_REVISION,
    });

    const terminalEvents = [];
    const subscription = host.subscribe(PRINCIPAL, { scope: "session", sessionId: SESSION_ID }, {
      deliver(event) {
        if (event.kind === "turn.completed" && event.turnId) terminalEvents.push(event);
      },
      close() {},
    });
    t.after(() => host.unsubscribe(subscription.subscriptionId, SESSION_ID));

    const providerRequestId = `${profile.id}-request-1`;
    const candidate = profile.parse(providerRequestId);
    const receiptWire = [];
    await coordinator.receiveCandidate({
      callId: CALL_ID,
      workBindingRevision: BINDING_REVISION,
      workSessionId: SESSION_ID,
      providerRequestId: candidate.providerRequestId,
      instruction: candidate.arguments.instruction,
    }, async (receipt) => {
      receiptWire.push(profile.receipt(providerRequestId, receipt));
      return { status: "sent", deliveryId: `${profile.id}-receipt` };
    });

    assert.equal(prompts.length, 1, "one provider request invokes the existing AgentHost runtime once");
    assert.equal(prompts[0].content, INSTRUCTION);
    assert.equal(prompts[0].voiceOrigin.callId, CALL_ID);
    assert.equal(prompts[0].voiceOrigin.operationId, updates.at(-1).operation.operationId);
    assert.equal(receiptWire.length, 1);
    profile.assertReceipt(receiptWire[0], providerRequestId, updates.at(-1).operation.operationId);

    const operation = coordinator.listOperations(CALL_ID)[0];
    assert.equal(operation.execution, "running");
    host.ingest({
      sessionId: SESSION_ID,
      turnId: operation.turnId,
      ts: Date.parse("2026-09-29T00:00:01.000Z"),
      event: { type: "agent_end", messageIds: [] },
    });

    assert.equal(terminalEvents.length, 1, "the authoritative AgentHost terminal event closes the operation");
    coordinator.reportTurnTerminal({
      sessionId: SESSION_ID,
      runtimeTurnId: terminalEvents[0].turnId,
      turnId: terminalEvents[0].turnId,
      status: "completed",
    });
    coordinator.reportTurnResult({
      callId: CALL_ID,
      operationId: operation.operationId,
      summary: "Task completed on the recorded turn.",
    });
    const terminalOperation = coordinator.listOperations(CALL_ID)[0];
    assert.equal(terminalOperation.execution, "completed");

    const feedback = {
      feedbackId: `${profile.id}-feedback`,
      callId: CALL_ID,
      workBindingRevision: BINDING_REVISION,
      operationId: operation.operationId,
      kind: "result",
      delivery: "speak-when-idle",
      content: `Task completed on turn ${terminalOperation.turnId}.`,
    };
    profile.assertResult(profile.result(providerRequestId, feedback), providerRequestId, terminalOperation.turnId);
  });
}
