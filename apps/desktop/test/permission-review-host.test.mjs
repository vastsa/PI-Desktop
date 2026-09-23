import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

register(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "helpers/ts-import-hooks.mjs")));
const { createHostRuntime } = await import("../electron/main/runtime/host.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

test("remote session review and grant IPC never fall through to local Host", async () => {
  const handlers = new Map();
  const hostCalls = [];
  registerAgentIpc({
    registrar: { handle: (name, callback) => handlers.set(name, callback) },
    getHost: () => ({ call: async (method) => { hostCalls.push(method); return { ok: true }; } }),
    getSidecar: () => null,
    getAgentHostBridge: () => null,
  });
  for (const channel of [IPC.invoke.permissionListSessionGrants,
    IPC.invoke.permissionClearSessionGrants, IPC.invoke.permissionListReviewHistory]) {
    await assert.rejects(handlers.get(channel)({ sessionId: "remote:host:session" }),
      { errorCode: "CAPABILITY_UNAVAILABLE" });
  }
  await assert.rejects(handlers.get(IPC.invoke.permissionRevokeSessionGrant)({
    sessionId: "remote:host:session", grantId: "grant-1",
  }), { errorCode: "CAPABILITY_UNAVAILABLE" });
  await assert.rejects(handlers.get(IPC.invoke.permissionTakeoverReview)({
    requestId: "remote:host:session#racp-approval:req-1",
  }), { errorCode: "CAPABILITY_UNAVAILABLE" });
  assert.deepEqual(hostCalls, []);
});

function fixture(hostDecision, reviewPermission = async () => ({ decision: "allow_once", risk: "low",
  authorization: "explicit", reason: "Requested", policyVersion: "1" }), takeoverError) {
  let notify;
  const resolved = Promise.withResolvers();
  const brokerDecisions = [];
  const events = [];
  const hostCalls = [];
  const host = {
    onNotification(handler) { notify = handler; },
    onExit() {},
    async call(method) {
      hostCalls.push(method);
      if (method === "permissions.takeoverReview" && takeoverError) throw takeoverError;
      if (method === "permissions.claimReview") return {
        token: "token", fingerprint: "fingerprint",
        action: { userRequest: "Read", toolName: "Read", arguments: { path: "a.txt" },
          workspace: "/project", permissionMode: "ask", isolation: "none", complete: true },
      };
      if (method === "permissions.resolveReview") {
        resolved.resolve();
        return { decision: hostDecision };
      }
      return { ok: true };
    },
  };
  const runtime = createHostRuntime({
    runtimeState: { host, sidecar: null, agentHostBridge: null },
    dataDir: "/tmp/pi-desktop-review-test",
    logger: { app() {}, child: () => ({ app() {} }), flushChild() {} },
    persistenceOutbox: { size: () => 0, flush: async () => undefined },
    activeToolCalls: new Map(),
    activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
    sessionProjects: new Map(),
    plugins: { drainToasts: () => [] },
    userMcp: {},
    pluginActiveInProject: () => true,
    sendToRenderer() {},
    emitAgentEvent: (event) => events.push(event),
    togglePluginLauncher: async () => undefined,
    finishTurn: async () => undefined,
    isTurnDispatchable: () => true,
    finishApprovedExecution: async () => undefined,
    activeTurns: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    importLegacyScheduled: async () => undefined,
    superviseRestart: async () => undefined,
    isQuitting: () => false,
    reviewPermission,
    settleExternalApproval: (requestId, decision) => brokerDecisions.push({ requestId, decision }),
  });
  runtime.wireHost(host);
  return { notify, resolved: resolved.promise, brokerDecisions, events,
    hostCalls, cancelReviewForEvent: runtime.cancelReviewForEvent,
    cancelReviewForSession: runtime.cancelReviewForSession,
    takeOverSessionReviews: runtime.takeOverSessionReviews };
}

test("stopping an active review cancels approval and denies the tool through Host", async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let aborted = false;
  const state = fixture("allow_once", (_action, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    started.resolve();
    return finish.promise;
  });
  state.notify("permissions.request", {
    requestId: "stop-review", sessionId: "session-1", toolCallId: "tool-stop",
    toolName: "Write", argsPreview: {}, risk: "high", reason: "Permission required",
    reviewState: "awaiting_review", createdAt: new Date().toISOString(),
  });
  await started.promise;
  await state.takeOverSessionReviews("session-1");
  assert.equal(aborted, true);
  assert.equal(state.hostCalls.includes("permissions.takeoverReview"), true);
  assert.deepEqual(state.hostCalls.slice(-2), ["permissions.takeoverReview", "permissions.resolve"]);
  finish.resolve({ decision: "allow_once", risk: "low", authorization: "explicit",
    reason: "Too late", policyVersion: "1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.hostCalls.includes("permissions.resolveReview"), false);
  assert.deepEqual(state.brokerDecisions, [{ requestId: "stop-review", decision: "deny" }]);
});

test("a request already settled by Host does not block graceful Stop", async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const state = fixture("allow_once", () => {
    started.resolve();
    return finish.promise;
  }, Object.assign(new Error("gone"), { data: { errorCode: "NOT_FOUND" } }));
  state.notify("permissions.request", {
    requestId: "settled", sessionId: "session-1", toolCallId: "tool-settled",
    toolName: "Read", argsPreview: {}, risk: "low", reason: "Review",
    reviewState: "awaiting_review", createdAt: new Date().toISOString(),
  });
  await started.promise;
  await state.takeOverSessionReviews("session-1");
  assert.equal(state.hostCalls.includes("permissions.resolve"), false);
  finish.resolve({ decision: "allow_once", risk: "low", authorization: "explicit",
    reason: "Late", policyVersion: "1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.brokerDecisions, []);
});

test("unexpected Host handoff failure stays observable and does not release the broker", async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const state = fixture("allow_once", () => {
    started.resolve();
    return finish.promise;
  }, Object.assign(new Error("database unavailable"), { errorCode: "INTERNAL" }));
  state.notify("permissions.request", {
    requestId: "failed", sessionId: "session-1", toolCallId: "tool-failed",
    toolName: "Read", argsPreview: {}, risk: "low", reason: "Review",
    reviewState: "awaiting_review", createdAt: new Date().toISOString(),
  });
  await started.promise;
  await assert.rejects(state.takeOverSessionReviews("session-1"), /database unavailable/);
  assert.deepEqual(state.brokerDecisions, []);
  finish.resolve({ decision: "needs_user", risk: "low", authorization: "none",
    reason: "Cancelled", policyVersion: "1" });
});

test("Host downgrade keeps manual permission pending and does not approve external broker", async () => {
  const state = fixture("needs_user");
  state.notify("permissions.request", {
    requestId: "request-1", sessionId: "session-1", toolCallId: "tool-1",
    toolName: "Read", argsPreview: { path: "a.txt" }, risk: "low",
    reason: "Permission required", reviewState: "awaiting_review",
    createdAt: new Date().toISOString(),
  });
  await state.resolved;
  // The model proposal is not authoritative, including after the awaited RPC.
  await Promise.resolve();
  assert.deepEqual(state.brokerDecisions, []);
  state.notify("permissions.reviewUpdated", {
    requestId: "request-1", reviewState: "user", reason: "Evidence became stale",
  });
  assert.equal(state.events.at(-1)?.event?.request?.reviewState, "user");
  assert.equal(state.events.at(-1)?.event?.request?.reason, "Evidence became stale");
  await state.takeOverSessionReviews("session-1");
  assert.equal(state.hostCalls.includes("permissions.takeoverReview"), false,
    "a manual fallback no longer belongs to the auto-review stop queue");
});

test("Host final deny prevails over a model's approval proposal", async () => {
  const state = fixture("deny");
  state.notify("permissions.request", {
    requestId: "request-2", sessionId: "session-1", toolCallId: "tool-2",
    toolName: "Read", argsPreview: {}, risk: "low", reason: "Permission required",
    reviewState: "awaiting_review", createdAt: new Date().toISOString(),
  });
  await state.resolved;
  await Promise.resolve();
  assert.deepEqual(state.brokerDecisions, [{ requestId: "request-2", decision: "deny" }]);
});

test("tool completion cancels an in-flight reviewer and discards its late approval", async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let aborted = false;
  const state = fixture("allow_once", (_action, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    started.resolve();
    return finish.promise;
  });
  state.notify("permissions.request", {
    requestId: "request-3", sessionId: "session-1", toolCallId: "tool-3",
    toolName: "Read", argsPreview: {}, risk: "low", reason: "Permission required",
    reviewState: "awaiting_review", createdAt: new Date().toISOString(),
  });
  await started.promise;
  state.cancelReviewForEvent({ sessionId: "session-1", ts: Date.now(),
    event: { type: "tool_end", toolCallId: "tool-3", result: {} } });
  await state.takeOverSessionReviews("session-1");
  assert.equal(state.hostCalls.includes("permissions.takeoverReview"), false,
    "a completed tool must not leave an auto-review request behind");
  assert.equal(aborted, true);
  finish.resolve({ decision: "allow_once", risk: "low", authorization: "explicit",
    reason: "Too late", policyVersion: "1", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.hostCalls.includes("permissions.resolveReview"), false);
  assert.deepEqual(state.brokerDecisions, []);
});
