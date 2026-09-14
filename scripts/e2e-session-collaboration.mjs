/**
 * Headless protocol E2E coverage for host-owned session collaboration.
 *
 * This deliberately exercises the same host RPC methods used by the reviewed
 * Session Orchestrator gateway without requiring Electron or a live provider.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const PROTOCOL_VERSION = 11;
const PLUGIN_ID = "pi.session-orchestrator";
const INDEPENDENT_ID = "E2E-SESSION-independent-top-level-communication";
const ORCHESTRATOR_ID = "E2E-PLUGIN-session-orchestrator-real-workers";
const projectPath = process.cwd();

const results = [];

function record(id, ok, detail = "") {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
}

function formatError(error) {
  if (!error) return "no error";
  const code = error.errorCode || error.rpc?.data?.errorCode;
  const message = error.message || String(error);
  return code ? `${code}: ${message}` : message;
}

function errorCode(error) {
  return error?.errorCode || error?.rpc?.data?.errorCode;
}
function rpcCode(error) {
  return error?.rpc?.code;
}

async function expectRpcError(host, method, params) {
  try {
    await host.call(method, params);
  } catch (error) {
    return error;
  }
  return null;
}

async function createAgentSession(host, title, permissionMode = "ask") {
  const created = await host.call("session.create", {
    title,
    mode: "agent",
    projectPath,
  });
  const id = created.session.id;
  const configured = await host.call("session.configure", {
    id,
    mode: "agent",
    permissionMode,
  });
  return configured.session;
}

async function sendMessage(host, {
  sourceSessionId,
  sessionId,
  content,
  idempotencyKey,
  kind = "message",
  sourceTurnId,
  notifyOnCompletion = true,
}) {
  const response = await host.call("session.collaboration.send", {
    sourceSessionId,
    sourceTurnId,
    sessionId,
    pluginId: PLUGIN_ID,
    kind,
    content,
    idempotencyKey,
    notifyOnCompletion,
  });
  return response.message;
}

function uiMessage(role, content) {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    status: "complete",
  };
}

async function completeDelivery(host, message, resultText) {
  const turn = await host.call("session.beginTurn", {
    sessionId: message.targetSessionId,
    sessionMessageId: message.id,
  });
  await host.call("session.appendMessage", {
    sessionId: message.targetSessionId,
    turnId: turn.turnId,
    message: uiMessage("user", message.content),
  });
  await host.call("session.appendMessage", {
    sessionId: message.targetSessionId,
    turnId: turn.turnId,
    message: uiMessage("assistant", resultText),
  });
  await host.call("session.endTurn", {
    turnId: turn.turnId,
    status: "completed",
    createNotification: false,
  });
  const settled = await host.call("session.collaboration.settle", {
    turnId: turn.turnId,
  });
  return { turnId: turn.turnId, callback: settled.callback };
}

async function failDelivery(host, message, errorText) {
  await host.call("session.collaboration.fail", {
    messageId: message.id,
    error: errorText,
  });
}

async function cancelRunningDelivery(host, message) {
  const turn = await host.call("session.beginTurn", {
    sessionId: message.targetSessionId,
    sessionMessageId: message.id,
  });
  const cancellation = await host.call("session.collaboration.cancel", {
    sessionId: message.targetSessionId,
    messageId: message.id,
    pluginId: PLUGIN_ID,
    sourceSessionId: message.sourceSessionId,
  });
  await host.call("session.endTurn", {
    turnId: turn.turnId,
    status: "aborted",
    createNotification: false,
  });
  const settled = await host.call("session.collaboration.settle", {
    turnId: turn.turnId,
  });
  return { turnId: turn.turnId, cancellation, callback: settled.callback };
}

async function main() {
  const hostBinary = resolveHostBinary();
  const dataDir = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-collaboration-"));
  const host = new Host(hostBinary, dataDir);
  const knownMessageIds = [];
  const hopMessageIds = [];

  try {
    const handshake = await host.start(PROTOCOL_VERSION);
    record(
      INDEPENDENT_ID,
      handshake.protocolVersion === PROTOCOL_VERSION,
      `handshake=${handshake.protocolVersion}`,
    );

    const source = await createAgentSession(host, "E2E collaboration source", "ask");
    const independent = await createAgentSession(host, "E2E independent session", "ask");

    const discovered = await host.call("session.collaboration.list");
    const listed = discovered.sessions || [];
    const listedIds = new Set(listed.map((entry) => entry.sessionId));
    const bounded = listed.every(
      (entry) =>
        !Object.hasOwn(entry, "messages") &&
        !Object.hasOwn(entry, "projectPath") &&
        !Object.hasOwn(entry, "credentials") &&
        !Object.hasOwn(entry, "messagePreview"),
    );
    record(
      INDEPENDENT_ID,
      listedIds.has(source.id) && listedIds.has(independent.id) && bounded,
      `discovered=${listed.length}`,
    );

    const beforeSend = await host.call("session.list");
    const beforeIds = new Set((beforeSend.sessions || []).map((entry) => entry.id));
    const outbound = await sendMessage(host, {
      sourceSessionId: source.id,
      sessionId: independent.id,
      content: "E2E independent delivery",
      idempotencyKey: "e2e-independent-outbound",
    });
    knownMessageIds.push(outbound.id);
    const outboundSettlement = await completeDelivery(
      host,
      outbound,
      "Independent session completed the requested review.",
    );
    const outboundRead = await host.call("session.collaboration.message", {
      messageId: outbound.id,
    });
    const outboundResult = await host.call("session.collaboration.result", {
      sessionId: independent.id,
      messageId: outbound.id,
      turnId: outboundSettlement.turnId,
    });
    const independentStatus = await host.call("session.collaboration.status", {
      sessionId: independent.id,
    });
    const afterSend = await host.call("session.list");
    const afterIds = new Set((afterSend.sessions || []).map((entry) => entry.id));
    record(
      INDEPENDENT_ID,
      outboundRead.message.status === "completed" &&
        outboundRead.message.sourceSessionId === source.id &&
        outboundRead.message.targetSessionId === independent.id &&
        outboundResult.ready === true &&
        outboundResult.message.result === "Independent session completed the requested review." &&
        outboundResult.message.turnId === outboundSettlement.turnId &&
        independentStatus.status === "completed" &&
        beforeIds.size === afterIds.size &&
        [...beforeIds].every((id) => afterIds.has(id)),
      `delivery=${outbound.id} turn=${outboundSettlement.turnId}`,
    );

    const reply = await sendMessage(host, {
      sourceSessionId: independent.id,
      sessionId: source.id,
      content: "E2E independent reply",
      idempotencyKey: "e2e-independent-reply",
    });
    knownMessageIds.push(reply.id);
    const replySettlement = await completeDelivery(host, reply, "Reply delivered to source.");
    const replyResult = await host.call("session.collaboration.result", {
      sessionId: source.id,
      messageId: reply.id,
      turnId: replySettlement.turnId,
    });
    record(
      INDEPENDENT_ID,
      replyResult.ready === true &&
        replyResult.message.status === "completed" &&
        replyResult.message.sourceSessionId === independent.id &&
        replyResult.message.targetSessionId === source.id &&
        replyResult.message.result === "Reply delivered to source.",
      `reply=${reply.id} turn=${replySettlement.turnId}`,
    );

    const missingStatusError = await expectRpcError(
      host,
      "session.collaboration.status",
      { sessionId: "missing-session-for-e2e" },
    );
    const missingSendError = await expectRpcError(
      host,
      "session.collaboration.send",
      {
        sourceSessionId: source.id,
        sessionId: "missing-session-for-e2e",
        pluginId: PLUGIN_ID,
        content: "must not be delivered",
        idempotencyKey: "e2e-missing-target",
      },
    );
    record(
      INDEPENDENT_ID,
      errorCode(missingStatusError) === "NOT_FOUND" &&
        rpcCode(missingStatusError) === 1007 &&
        errorCode(missingSendError) === "PERMISSION_DENIED" &&
        rpcCode(missingSendError) === 1003,
      `status=${errorCode(missingStatusError)} send=${errorCode(missingSendError)}`,
    );

    const spawned = await host.call("session.collaboration.spawn", {
      sourceSessionId: source.id,
      pluginId: PLUGIN_ID,
      title: "E2E spawned worker",
      content: "E2E worker task",
      idempotencyKey: "e2e-worker-spawn",
    });
    const worker = spawned.sessionId;
    const workerMessage = spawned.message;
    knownMessageIds.push(workerMessage.id);
    const workerSummary = await host.call("session.get", { id: worker });
    const workerSettlement = await completeDelivery(host, workerMessage, "Worker result.");
    const workerResult = await host.call("session.collaboration.result", {
      sessionId: worker,
      messageId: workerMessage.id,
      turnId: workerSettlement.turnId,
    });
    const workerStatus = await host.call("session.collaboration.status", {
      sessionId: worker,
    });
    const parentPendingAfterWorker = await host.call("session.collaboration.pending", {
      sessionId: source.id,
    });
    const workerCallback = workerSettlement.callback;
    const workerSettlementAgain = await host.call("session.collaboration.settle", {
      turnId: workerSettlement.turnId,
    });
    record(
      ORCHESTRATOR_ID,
      worker !== source.id &&
        workerMessage.kind === "task" &&
        workerMessage.status === "queued" &&
        workerSummary.session?.projectPath === source.projectPath &&
        workerSummary.session?.permissionMode === source.permissionMode &&
        workerResult.ready === true &&
        workerResult.message.result === "Worker result." &&
        workerStatus.status === "completed" &&
        workerCallback?.kind === "completion" &&
        parentPendingAfterWorker.messages?.some(
          (message) => message.id === workerCallback.id && message.replyToMessageId === workerMessage.id,
        ) &&
        workerSettlementAgain.callback?.id === workerCallback.id,
      `worker=${worker} message=${workerMessage.id}`,
    );

    const failureTarget = await createAgentSession(host, "E2E failure target", "ask");
    const failedMessage = await sendMessage(host, {
      sourceSessionId: source.id,
      sessionId: failureTarget.id,
      content: "E2E failing delivery",
      idempotencyKey: "e2e-failing-delivery",
    });
    knownMessageIds.push(failedMessage.id);
    await failDelivery(host, failedMessage, "E2E_DISPATCH_FAILED");
    await failDelivery(host, failedMessage, "E2E_DISPATCH_FAILED");
    const failedRead = await host.call("session.collaboration.message", {
      messageId: failedMessage.id,
    });
    const failedResult = await host.call("session.collaboration.result", {
      sessionId: failureTarget.id,
      messageId: failedMessage.id,
    });
    const failedPending = await host.call("session.collaboration.pending", {
      sessionId: source.id,
    });
    const failedCallbacks = (failedPending.messages || []).filter(
      (message) => message.replyToMessageId === failedMessage.id,
    );
    record(
      ORCHESTRATOR_ID,
      failedRead.message.status === "failed" &&
        failedRead.message.error === "E2E_DISPATCH_FAILED" &&
        failedResult.ready === true &&
        failedResult.message.status === "failed" &&
        failedResult.message.error === "E2E_DISPATCH_FAILED" &&
        failedCallbacks.length === 1 &&
        failedCallbacks[0].kind === "completion" &&
        failedCallbacks[0].status === "queued",
      `failed=${failedMessage.id}`,
    );

    const cancelTarget = await createAgentSession(host, "E2E cancellation target", "ask");
    const cancelledMessage = await sendMessage(host, {
      sourceSessionId: source.id,
      sessionId: cancelTarget.id,
      content: "E2E cancellable delivery",
      idempotencyKey: "e2e-cancellable-delivery",
    });
    knownMessageIds.push(cancelledMessage.id);
    const cancellation = await cancelRunningDelivery(host, cancelledMessage);
    const cancelledAgain = await host.call("session.collaboration.cancel", {
      sessionId: cancelTarget.id,
      messageId: cancelledMessage.id,
      pluginId: PLUGIN_ID,
      sourceSessionId: source.id,
    });
    const cancelledRead = await host.call("session.collaboration.message", {
      messageId: cancelledMessage.id,
    });
    const retained = await host.call("session.get", { id: cancelTarget.id });
    const cancelledPending = await host.call("session.collaboration.pending", {
      sessionId: source.id,
    });
    const cancelledCallbacks = (cancelledPending.messages || []).filter(
      (message) => message.replyToMessageId === cancelledMessage.id,
    );
    record(
      ORCHESTRATOR_ID,
      cancellation.cancellation.cancelled === true &&
        cancellation.cancellation.runningTurnIds?.includes(cancellation.turnId) &&
        cancelledAgain.cancelled === true &&
        cancelledRead.message.status === "cancelled" &&
        retained.session?.id === cancelTarget.id &&
        cancellation.callback?.kind === "completion" &&
        cancellation.callback?.replyToMessageId === cancelledMessage.id &&
        cancelledCallbacks.length === 1 &&
        cancelledCallbacks[0].status === "queued",
      `cancelled=${cancelledMessage.id} turn=${cancellation.turnId}`,
    );

    const restricted = await createAgentSession(host, "E2E restricted source", "ask");
    const elevated = await createAgentSession(host, "E2E elevated target", "auto");
    const permissionError = await expectRpcError(
      host,
      "session.collaboration.send",
      {
        sourceSessionId: restricted.id,
        sessionId: elevated.id,
        pluginId: PLUGIN_ID,
        content: "must not cross permission ceiling",
        idempotencyKey: "e2e-permission-ceiling",
      },
    );
    record(
      ORCHESTRATOR_ID,
      errorCode(permissionError) === "PERMISSION_DENIED" &&
        rpcCode(permissionError) === 1003,
      `permission=${errorCode(permissionError)}`,
    );

    const hopA = await createAgentSession(host, "E2E hop source", "ask");
    const hopB = await createAgentSession(host, "E2E hop target", "ask");
    let hopSource = hopA.id;
    let hopTarget = hopB.id;
    let hopMessage = await sendMessage(host, {
      sourceSessionId: hopSource,
      sessionId: hopTarget,
      content: "E2E hop 1",
      idempotencyKey: "e2e-hop-1",
      notifyOnCompletion: false,
    });
    hopMessageIds.push(hopMessage.id);

    // A top-level send starts with eight autonomous hops remaining. Seven
    // bound sends leave one; the eighth must be rejected before insertion.
    for (let index = 2; index <= 8; index += 1) {
      const turn = await host.call("session.beginTurn", {
        sessionId: hopTarget,
        sessionMessageId: hopMessage.id,
      });
      const nextMessage = await sendMessage(host, {
        sourceSessionId: hopTarget,
        sourceTurnId: turn.turnId,
        sessionId: hopSource,
        content: `E2E hop ${index}`,
        idempotencyKey: `e2e-hop-${index}`,
        notifyOnCompletion: false,
      });
      hopMessageIds.push(nextMessage.id);
      await host.call("session.endTurn", {
        turnId: turn.turnId,
        status: "completed",
        createNotification: false,
      });
      await host.call("session.collaboration.settle", { turnId: turn.turnId });
      hopMessage = nextMessage;
      [hopSource, hopTarget] = [hopTarget, hopSource];
    }

    const finalHopTurn = await host.call("session.beginTurn", {
      sessionId: hopTarget,
      sessionMessageId: hopMessage.id,
    });
    const hopTargetBefore = await host.call("session.collaboration.status", {
      sessionId: hopSource,
    });
    const hopExchangeIdsBefore = (hopTargetBefore.recentExchanges || []).map(
      (exchange) => exchange.messageId,
    );
    const hopError = await expectRpcError(
      host,
      "session.collaboration.send",
      {
        sourceSessionId: hopTarget,
        sourceTurnId: finalHopTurn.turnId,
        sessionId: hopSource,
        pluginId: PLUGIN_ID,
        content: "must exceed hop ceiling",
        idempotencyKey: "e2e-hop-overflow",
        notifyOnCompletion: false,
      },
    );
    const hopTargetAfter = await host.call("session.collaboration.status", {
      sessionId: hopSource,
    });
    const hopExchangeIdsAfter = (hopTargetAfter.recentExchanges || []).map(
      (exchange) => exchange.messageId,
    );
    await host.call("session.endTurn", {
      turnId: finalHopTurn.turnId,
      status: "aborted",
      createNotification: false,
    });
    await host.call("session.collaboration.settle", { turnId: finalHopTurn.turnId });
    record(
      ORCHESTRATOR_ID,
      errorCode(hopError) === "LIMIT_EXCEEDED" &&
        rpcCode(hopError) === 1002 &&
        JSON.stringify(hopExchangeIdsBefore) === JSON.stringify(hopExchangeIdsAfter),
      `hop=${errorCode(hopError)}`,
    );

    const pending = await host.call("session.collaboration.pending", {
      sessionId: source.id,
    });
    const allKnownMessages = [...knownMessageIds, ...hopMessageIds];
    const settledMessages = await Promise.all(
      allKnownMessages.map((messageId) =>
        host.call("session.collaboration.message", { messageId }),
      ),
    );
    const noRunningLedgerEntries = settledMessages.every(
      (response) => response.message && response.message.status !== "running",
    );
    const pendingIsQueued = (pending.messages || []).every(
      (message) => message.status === "queued" && message.kind === "completion",
    );
    record(
      ORCHESTRATOR_ID,
      noRunningLedgerEntries && pendingIsQueued,
      `checked=${settledMessages.length} callbacks=${pending.messages?.length || 0}`,
    );
  } catch (error) {
    record(ORCHESTRATOR_ID, false, `unexpected: ${formatError(error)}`);
  } finally {
    try {
      await host.stop();
    } catch (error) {
      record(ORCHESTRATOR_ID, false, `host cleanup: ${formatError(error)}`);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

await main();
