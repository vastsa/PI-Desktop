import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);
const { createAgentHostBridge } = await import(
  "../electron/main/agent-host-bridge.ts"
);
const { createSessionRuntime } = await import(
  "../src/stores/runtime/session-runtime.ts"
);
const { createEventsSlice } = await import(
  "../src/stores/slices/events-slice.ts"
);
const {
  assistantErrorMessage,
  sessionModeForPlanningState,
  withCompactionMark,
  withoutRecordKey,
} = await import("../src/stores/helpers/store-helpers.ts");
const { IPC } = await import("@pi-desktop/shared");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createMainCrashFixture() {
  const sessionId = "s-crash";
  const crashedTurnId = "turn-oom";
  const activeTurns = new Map([[sessionId, crashedTurnId]]);
  const hostCalls = [];
  const rendererEvents = [];
  const endTurnDeferred = deferred();

  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => sessionId,
  });

  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      if (method === "session.get") {
        return { session: { id: params.id, permissionMode: "ask" } };
      }
      if (method === "session.endTurn") {
        return endTurnDeferred.promise;
      }
      if (method === "session.appendMessage") {
        return { ok: true };
      }
      if (method === "session.queueList") {
        return { entries: [] };
      }
      throw new Error(`Unexpected host call: ${method}`);
    },
  };

  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => host,
    isSessionBusy: coordination.isSessionBusy,
    log() {},
    async invoke() {
      return { ok: true };
    },
  });

  bridge.ingest({
    sessionId,
    turnId: crashedTurnId,
    ts: 100,
    event: { type: "agent_start" },
  });

  const runtimeState = { host, agentHostBridge: bridge };
  const emitAgentEvent = (envelope) => {
    runtimeState.agentHostBridge?.ingest(envelope);
    rendererEvents.push(envelope);
  };

  const { finishTurn } = createPlanRuntime({
    runtimeState,
    planState: { approvedExecutionDrain: null },
    logger: { app() {} },
    sendToRenderer(channel, payload) {
      if (channel === IPC.event.agentMessage) {
        rendererEvents.push(payload);
      }
    },
    coordination,
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(),
    finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(),
    pendingExecutionFinishes: new Map(),
    announceTurnEnded() {},
    emitAgentEvent,
    acquireSessionOperation: async () => () => {},
    resolveAgentRuntimeLaunch: async () => {
      throw new Error("not exercised");
    },
    isQuitting: () => false,
  });

  return {
    sessionId,
    crashedTurnId,
    activeTurns,
    hostCalls,
    rendererEvents,
    endTurnDeferred,
    bridge,
    finishTurn,
  };
}

function createRendererStoreHarness({
  activeMessages = [],
  backgroundMessages = [],
} = {}) {
  let runtime;
  let refreshCount = 0;
  let state = {
    activeSessionId: "active",
    isRunning: true,
    error: null,
    errorCode: null,
    errorRetriable: null,
    messages: activeMessages,
    retainedSessionIds: ["active", "background"],
    retainedTranscripts: {
      active: activeMessages,
      background: backgroundMessages,
    },
    runningSessions: { active: true, background: true },
    agentStatuses: { active: "thinking", background: "running_tool" },
    pendingPermissions: {},
    pendingAsks: {},
    askDrafts: {},
    sessionOutcomes: {},
    latestTurnResults: {},
    planningStates: {},
    planCheckpoints: {},
    pendingPlans: {},
    sessionCompactions: {},
    sessionHistory: {},
    pluginViews: [],
    openWorkPanelTabForSession: () => {},
    restorePendingPlan: async () => {},
    refreshQueuedPrompts: async () => {},
    refreshSessions: async () => {
      refreshCount += 1;
    },
    showToast: () => {},
  };

  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      const next = typeof patch === "function" ? patch(state) : patch;
      if (!next || next === state) return;
      state = { ...state, ...next };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };

  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript("active", activeMessages);
  runtime.cacheSessionTranscript("background", backgroundMessages);

  Object.assign(
    state,
    createEventsSlice({
      ...access,
      runtime,
      withoutRecordKey,
      sessionModeForPlanningState,
      openPlanArtifact: () => {},
      notifyInteractivePrompt: () => {},
      flushPendingSessionConfiguration: async () => {},
      assistantErrorMessage,
      withCompactionMark,
    }),
  );

  return {
    get: () => state,
    runtime,
    refreshCount: () => refreshCount,
  };
}

test("crashed-turn finalization persists the classified error, settles RACP as interrupted, and notifies the renderer", async () => {
  const recovered = {
    id: "msg-partial",
    turnId: "turn-oom",
    role: "assistant",
    content: "Partial output before OOM",
    createdAt: "2026-11-24T17:53:30.000Z",
    status: "aborted",
  };
  const fx = createMainCrashFixture();
  const observedRacpEvents = [];
  const unsubscribe = fx.bridge.onSessionEvent(fx.sessionId, (event) => {
    observedRacpEvents.push(event);
  });

  const crashError = {
    code: "AGENT_SIDECAR_OOM",
    message: "AGENT_SIDECAR_OOM",
    retriable: false,
  };

  const settlement = fx.finishTurn(fx.sessionId, "aborted", "AGENT_SIDECAR_OOM", {
    recoverInflight: true,
    turnId: fx.crashedTurnId,
    crashError,
  });

  await setImmediate();
  fx.endTurnDeferred.resolve({ ok: true, recovered });
  await settlement;
  unsubscribe();

  const endTurnCall = fx.hostCalls.find((c) => c.method === "session.endTurn");
  assert.ok(endTurnCall, "session.endTurn is called");
  assert.equal(endTurnCall.params.status, "aborted");
  assert.equal(endTurnCall.params.errorCode, "AGENT_SIDECAR_OOM");
  assert.equal(endTurnCall.params.recoverInflight, true);

  const appendCall = fx.hostCalls.find((c) => c.method === "session.appendMessage");
  assert.ok(appendCall, "structured crash error row is persisted");
  assert.equal(appendCall.params.turnId, fx.crashedTurnId);
  assert.equal(appendCall.params.message.status, "error");
  assert.equal(appendCall.params.message.isError, true);
  assert.equal(appendCall.params.message.error.code, "AGENT_SIDECAR_OOM");

  assert.deepEqual(
    fx.rendererEvents.map((e) => e.event.type),
    ["message_end", "message_end", "error"],
    "recovered reply, persisted crash message, and terminal error reach the renderer in order",
  );
  assert.equal(fx.rendererEvents[2].event.error.code, "AGENT_SIDECAR_OOM");

  const interruptedEvent = observedRacpEvents.find(
    (e) => e.kind === "turn.interrupted",
  );
  assert.ok(interruptedEvent, "AgentHost closes the crashed turn as interrupted");
  const racpTurn = fx.bridge.agentHost.getTurn(fx.crashedTurnId);
  assert.equal(racpTurn.status, "interrupted");
  assert.equal(racpTurn.error?.code, "AGENT_SIDECAR_OOM");
  assert.equal(
    observedRacpEvents.some((e) => e.kind === "turn.failed"),
    false,
    "synthetic renderer error does not misclassify the RACP turn as failed",
  );
});

test("crashed-turn finalization suppresses stale crash bubbles when a newer turn already owns the session", async () => {
  const fx = createMainCrashFixture();
  const settlement = fx.finishTurn(
    fx.sessionId,
    "aborted",
    "AGENT_SIDECAR_CRASHED",
    {
      recoverInflight: true,
      turnId: fx.crashedTurnId,
      crashError: {
        code: "AGENT_SIDECAR_CRASHED",
        message: "AGENT_SIDECAR_CRASHED",
        retriable: false,
      },
    },
  );

  await setImmediate();
  fx.activeTurns.set(fx.sessionId, "turn-newer");
  fx.endTurnDeferred.resolve({ ok: true });
  await settlement;

  assert.equal(
    fx.hostCalls.some((c) => c.method === "session.appendMessage"),
    false,
    "stale turn does not append an out-of-order crash row after a newer turn started",
  );
  assert.equal(
    fx.rendererEvents.length,
    0,
    "stale turn does not emit renderer terminal events into the newer turn",
  );
  assert.equal(fx.activeTurns.get(fx.sessionId), "turn-newer");
});

test("renderer settles running tools, streaming bubbles, running badges, and session list for active and background crashes", () => {
  const runningTool = {
    id: "tool-1",
    turnId: "turn-1",
    role: "tool",
    content: "",
    createdAt: "2026-11-24T17:53:10.000Z",
    toolCallId: "tool-1",
    toolName: "Bash",
    toolStatus: "running",
    status: "streaming",
  };
  const streamingReply = {
    id: "msg-stream",
    turnId: "turn-1",
    role: "assistant",
    content: "Working on it...",
    createdAt: "2026-11-24T17:53:20.000Z",
    status: "streaming",
  };

  const store = createRendererStoreHarness({
    activeMessages: [runningTool, streamingReply],
    backgroundMessages: [{ ...runningTool, id: "bg-tool", toolCallId: "bg-tool" }, { ...streamingReply, id: "bg-stream" }],
  });

  const crashError = {
    code: "AGENT_SIDECAR_OOM",
    message: "AGENT_SIDECAR_OOM",
    retriable: false,
  };
  const persistedCrashRow = {
    id: "err-active",
    turnId: "turn-1",
    role: "assistant",
    content: "",
    createdAt: "2026-11-24T17:53:30.000Z",
    status: "error",
    isError: true,
    error: crashError,
  };

  // Active session receives persisted message_end followed by error.
  store.get().handleAgentEvent({
    sessionId: "active",
    turnId: "turn-1",
    ts: 1_000,
    event: { type: "message_end", message: persistedCrashRow },
  });
  store.get().handleAgentEvent({
    sessionId: "active",
    turnId: "turn-1",
    ts: 1_001,
    event: { type: "error", error: crashError },
  });

  const activeState = store.get();
  assert.equal(activeState.isRunning, false);
  assert.equal(activeState.runningSessions.active, false);
  assert.equal(activeState.agentStatuses.active, undefined);
  assert.equal(activeState.latestTurnResults.active?.status, "failed");
  assert.equal(activeState.latestTurnResults.active?.errorCode, "AGENT_SIDECAR_OOM");
  assert.equal(activeState.messages.length, 3, "does not duplicate persisted crash bubble");
  assert.equal(activeState.messages[0].toolStatus, "error");
  assert.equal(activeState.messages[0].isError, true);
  assert.equal(activeState.messages[1].status, "error");
  assert.equal(activeState.messages[2].error?.code, "AGENT_SIDECAR_OOM");
  assert.equal(store.refreshCount(), 1);

  // Background session receives standalone error event and settles its cached transcript.
  store.get().handleAgentEvent({
    sessionId: "background",
    turnId: "turn-bg",
    ts: 2_000,
    event: { type: "error", error: crashError },
  });

  const afterBg = store.get();
  assert.equal(afterBg.runningSessions.background, false);
  assert.equal(afterBg.agentStatuses.background, undefined);
  assert.equal(afterBg.latestTurnResults.background?.errorCode, "AGENT_SIDECAR_OOM");
  assert.equal(store.refreshCount(), 2);

  const bgCached = store.runtime.sessionTranscriptCache.get("background");
  assert.ok(bgCached);
  assert.equal(bgCached.length, 3);
  assert.equal(bgCached[0].toolStatus, "error");
  assert.equal(bgCached[1].status, "error");
  assert.equal(bgCached[2].role, "assistant");
  assert.equal(bgCached[2].isError, true);
  assert.equal(bgCached[2].error?.code, "AGENT_SIDECAR_OOM");
  assert.equal(bgCached[2].turnId, "turn-bg");
});
