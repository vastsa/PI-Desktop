import assert from "node:assert/strict";
import { IPC } from "@pi-desktop/shared";
import { sessionWorkspaceIdentity } from "@pi-desktop/host-runtime";

export const WORK_SESSION_ID = "live-work-production-session";
const projectId = "production-fixture-project";
const projectPath = "/tmp/pi-live-work-production-fixture";
export const WORK_INSTRUCTION = "Inspect the login flow and report verified findings.";
export const WORK_RESULT = "The login flow correctly rejects expired credentials.";

// Production Main handlers and AgentHost; only Host RPC, classifier and sidecar I/O are fixtures.
export async function createProductionWorkHarness(t, server, options = {}) {
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  const { createLiveWorkBridge } = await server.ssrLoadModule("/electron/main/live-voice/work-bridge.ts");
  const { registerAgentIpc } = await server.ssrLoadModule("/electron/main/ipc/agent-ipc.ts");
  const prompts = [];
  const persistedMessages = [];
  const invocationLog = [];
  const updates = [];
  const registeredHandlers = new Map();
  const calls = new Set();
  const results = new Map();
  let durableTurnSequence = 0;
  let runtimePromptSequence = 0;
  let agentHostBridge;
  let terminalSeen = false;
  let historyReadsAfterTerminal = 0;
  const finalMessage = {
    id: "assistant-final-1", turnId: "runtime-turn-1", role: "assistant",
    content: WORK_RESULT, status: "complete", createdAt: "2026-09-29T00:00:05.000Z",
  };
  const sessionRecord = () => ({
    id: WORK_SESSION_ID, title: "Production fixture", projectId, projectPath,
    mode: "agent", permissionMode: "ask",
    createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
    messages: terminalSeen && historyReadsAfterTerminal >= 2 ? [finalMessage] : [],
  });
  const host = {
    async call(method, params) {
      if (method === "session.list") return { sessions: [{ ...sessionRecord(), source: "desktop" }] };
      if (method === "session.get") {
        if (terminalSeen) historyReadsAfterTerminal += 1;
        return { session: sessionRecord() };
      }
      if (method === "settings.get") return {};
      if (method === "session.beginTurn") return { turnId: `durable-turn-${++durableTurnSequence}` };
      if (method === "session.appendMessage") { persistedMessages.push(params.message); return {}; }
      if (method === "session.queueList") return { entries: [] };
      if (method === "session.queuePush") return {};
      if (method === "session.queueRemove") return { removed: true };
      if (method === "session.queuePrioritize") return {};
      if (method === "session.queueReorder") return { moved: true };
      throw new Error(`unexpected Host RPC: ${method}`);
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => registeredHandlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({
      setProjectInstructionRoot() {}, clearProjectInstructionRoot() {}, clearVendorAuthBindings() {},
      async call(method) {
        if (method === "agent.prompt") return { accepted: true, turnId: `runtime-turn-${++runtimePromptSequence}` };
        if (method === "agent.abort") return { ok: true, aborted: true };
        throw new Error(`unexpected sidecar RPC: ${method}`);
      },
    }),
    getAgentHostBridge: () => agentHostBridge ?? null,
    logger: { app() {} },
    vendorOAuth: { async resolveAuth() { throw new Error("OAuth is not used by this fixture"); } },
    agentExtensions: { cancelPrompts() {} }, cancelSessionTools() {},
    persistenceOutbox: { async flush() {} },
    dataDir: "/tmp/pi-live-work-production-fixture-data",
    activeTurns: new Map(), isTurnDispatchable: () => true, activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    async resolveAgentRuntimeLaunch(_id, session) {
      return {
        providerId: "fixture-provider", modelId: "fixture-model", projectPath: session.projectPath,
        sidecarParams: { provider: { modelConfig: { input: ["text"] } } },
      };
    },
    async acquireSessionOperation() { return () => {}; },
    async finishTurn() { throw new Error("unexpected turn finalization in prompt path"); },
    lockAbortReason() {}, async finishApprovedExecution() {}, async dispatchApprovedPlan() {},
    async dispatchExecutionForProposal() {},
    emitAgentEvent(event) { agentHostBridge?.ingest(event); },
    setNotificationViewingSessionId() {}, async optionalWorkspaceRoot() { return null; },
    composerCommandService: { async buildComposerCommands() { return []; } },
    async loadComposerTemplatesCached() { return []; },
  });
  agentHostBridge = createAgentHostBridge({
    channels: IPC.invoke, getHost: () => host, isSessionBusy: () => false, log() {},
    async invoke(channel, args) {
      invocationLog.push({ channel, args });
      if (channel === IPC.invoke.agentPrompt) prompts.push(args[0]);
      const handler = registeredHandlers.get(channel);
      assert.equal(typeof handler, "function", "the registered Main handler must receive the request");
      return handler(...args);
    },
  });
  const bridge = createLiveWorkBridge({
    getHost: () => host, getAgentHostBridge: () => agentHostBridge,
    vendorOAuth: { async resolveAuth() { throw new Error("OAuth is not used by this fixture"); } },
    async navigateSession() {},
    async resolveAgentRuntimeLaunch(_id, session) {
      assert.equal("projectPath" in session, false, "private paths must not enter classifier setup");
      assert.equal("workspaceIdentity" in session, false, "private fingerprints must not enter classifier setup");
      return { providerId: "fixture-provider", sidecarParams: { provider: {
        id: "fixture-provider", name: "Fixture Provider", vendorKey: "openai",
        apiStyle: "chat_completions", baseUrl: "https://fixture.invalid/v1",
        modelId: "fixture-model", apiKey: "fixture-key", authKind: "api_key",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      } } };
    },
    async completeIntent(_provider, context, _thinking, requestOptions) {
      assert.ok(requestOptions.signal instanceof AbortSignal);
      return { text: JSON.stringify({
        kind: "new-task",
        relationToActive: String(context.messages[0]?.content).includes("independent follow-up") ? "independent" : "unspecified",
        explicitRepeat: false,
      }) };
    },
    waitForResultRetry: async () => {},
    onOperation(callId, update) {
      updates.push(update);
      if (update.operation.resultState === "available") results.set(update.operation.operationId, update.operation);
      options.onOperation?.(callId, update);
    },
  });
  t.after(() => { for (const callId of calls) bridge.closeCall(callId); });
  return {
    bridge, agentHostBridge, prompts, persistedMessages, invocationLog, updates, results,
    openCall(callId, binding = { workSessionId: WORK_SESSION_ID, workBindingRevision: 3, label: "Production fixture", contextEnabled: false }) {
      calls.add(callId);
      bridge.openCall({ ...binding, callId }, sessionWorkspaceIdentity({ projectId, projectPath }));
    },
    endTurn(turnId = "runtime-turn-1") {
      terminalSeen = true;
      agentHostBridge.agentHost.endTurn(WORK_SESSION_ID, turnId, "completed");
    },
    get historyReadsAfterTerminal() { return historyReadsAfterTerminal; },
  };
}

export async function settleUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), message);
}
