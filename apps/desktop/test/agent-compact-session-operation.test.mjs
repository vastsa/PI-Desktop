import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = transpile(file);
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: path.resolve(file.pathname),
  });
}

/** The production promise-tail session operation, same semantics. */
function createSessionOperations() {
  const tails = new Map();
  return async function acquireSessionOperation(sessionId) {
    const id = sessionId.trim();
    const previous = tails.get(id) ?? Promise.resolve();
    let resolveCurrent;
    const current = new Promise((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current);
    tails.set(id, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (tails.get(id) === tail) tails.delete(id);
    };
  };
}

function buildHarness({ hostCall, sidecarCall, resolveSessionMessageInput }) {
  const admissionTail =
    resolveSessionMessageInput ??
    (async () => { throw new Error("sentinel: prompt admission tail"); });
  const handlers = new Map();
  const acquireSessionOperation = createSessionOperations();
  const activeTurns = new Map();
  const host = { call: (method, input) => hostCall(method, input) };
  const sidecar = {
    call: (method, input) => sidecarCall(method, input),
    setProjectInstructionRoot() {},
  };
  const agentIpc = load("../electron/main/ipc/agent-ipc.ts", {
    "@pi-desktop/shared": {
      IPC,
      ErrorCodes,
      compactionRecordId: (session) => session?.compactionRecordId ?? null,
      composeMentionPrompt: (parts) => parts?.prompt ?? "",
      findSkillMentions: () => [],
      isGlobalPermissionMode: () => false,
      isRpcTimeoutError: () => false,
    },
    "../composer-mcp": { expandMcpInvocation: () => null },
    "../runtime/mode-runs": { modeContinuationOrigin: () => undefined },
    "../runtime/background-continuations": {
      backgroundContinuationOrigin: () => undefined,
      backgroundCompletionMessage: () => assert.fail("compaction must not deliver a background result"),
    },
    "../runtime/goal-start": { goalPromptMode: () => null, goalStartRequested: () => false },
    "@pi-desktop/agent-runtime": { expandSlashInvocation: () => null, visionFromModelConfig: () => null },
    "../prompt-attachments": {
      appendPromptFallbackPaths: () => [],
      durableUserMessageId: () => "user-message",
      preparePromptAttachments: async () => [],
    },
    "../session-references": { resolveSessionReferences: async () => [] },
    "../agent-mentions": { resolvePromptAgentMentions: async () => [] },
    "../runtime/user-message-provenance": { isAutomationRequest: () => false },
    "@pi-desktop/host-runtime": {
      executionFromResponse: () => null,
      resolveSessionMessageInput: admissionTail,
    },
  });
  agentIpc.registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => ({ markAborting() {} }),
    logger: { app() {} },
    agentExtensions: { cancelPrompts() {} },
    cancelSessionTools() {},
    persistenceOutbox: { dropSession: async () => undefined },
    dataDir: "data-dir",
    activeTurns,
    completionNoticeTurns: new Set(),
    recordTurnStart() {},
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({
      sidecarParams: {},
      providerId: "provider",
      modelId: "model",
      workspaceRoot: null,
      projectPath: null,
    }),
    acquireSessionOperation,
    finishTurn: async () => undefined,
    lockAbortReason() {},
    finishApprovedExecution: async () => undefined,
    dispatchApprovedPlan() {},
    dispatchExecutionForProposal() {},
    emitAgentEvent() {},
    setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
    modeRuns: {},
  });
  return { handlers, activeTurns };
}

const compact = (h, req) => h.handlers.get(IPC.invoke.agentCompact)(req);
const prompt = (h, req) => h.handlers.get(IPC.invoke.agentPrompt)(req);
const abort = (h, req) => h.handlers.get(IPC.invoke.agentAbort)(req);

test("a prompt that queues behind compaction setup is refused by the compacting mark", async () => {
  let releaseSettings;
  let releaseCompact;
  let turnHostCalls = 0;
  const h = buildHarness({
    hostCall: async (method) => {
      if (method === "settings.get") {
        await new Promise((resolve) => { releaseSettings = resolve; });
        return {};
      }
      if (method === "session.get") return { session: { id: "s1", compactionRecordId: "c0" } };
      turnHostCalls += 1;
      return {};
    },
    sidecarCall: async (method) => {
      if (method === "agent.compact") {
        await new Promise((resolve) => { releaseCompact = resolve; });
        return { ok: true };
      }
      throw new Error(`unexpected sidecar call: ${method}`);
    },
  });

  const compacting = compact(h, { sessionId: "s1" });
  // The prompt is issued while compaction still holds the operation: its
  // acquire must wait through the setup window, and the mark it then sees
  // must refuse it — the compaction's own admission stays exclusive.
  const submitted = prompt(h, { sessionId: "s1", content: "hello" }).catch(
    (error) => error,
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseSettings();
  const rejection = await submitted;
  assert.equal(typeof releaseCompact, "function",
    "the compaction is still awaiting the sidecar while the prompt settles");
  assert.equal(rejection.errorCode, ErrorCodes.AGENT_BUSY);
  assert.match(rejection.message, /compacting/);
  assert.equal(turnHostCalls, 0, "no turn began behind the compaction");
  releaseCompact();
  await compacting;
});

test("abort does not wait for the in-flight compaction, and the mark clears when it settles", async () => {
  let releaseCompact;
  const h = buildHarness({
    hostCall: async (method) => {
      if (method === "session.get") return { session: { id: "s1", compactionRecordId: "c0" } };
      return {};
    },
    sidecarCall: async (method) => {
      if (method === "agent.compact") {
        await new Promise((resolve) => { releaseCompact = resolve; });
        return { ok: true };
      }
      if (method === "agent.abort") return { ok: true };
      throw new Error(`unexpected sidecar call: ${method}`);
    },
  });

  const compacting = compact(h, { sessionId: "s1" });
  await new Promise((resolve) => setImmediate(resolve));
  // Stop must acquire the released operation while agent.compact is still in
  // flight — that is exactly what releasing before the sidecar call buys.
  const stopped = await abort(h, { sessionId: "s1" });
  assert.deepEqual(stopped, { ok: true });
  assert.equal(typeof releaseCompact, "function", "compaction is still awaiting the sidecar");

  releaseCompact();
  await compacting;

  // With the mark cleared, a prompt passes admission again (sentinel proves
  // it got past the compacting check).
  const admitted = await prompt(h, { sessionId: "s1", content: "hello" }).catch(
    (error) => error,
  );
  assert.match(admitted.message, /sentinel/);
});

test("an idle compaction still refuses a session with an active turn", async () => {
  const h = buildHarness({
    hostCall: async () => ({}),
    sidecarCall: async () => ({}),
  });
  h.activeTurns.set("s1", "turn-1");
  await assert.rejects(
    compact(h, { sessionId: "s1" }),
    (error) => error.errorCode === ErrorCodes.AGENT_BUSY,
  );
});

test("a duplicate compact is refused at admission and never clears the first guard", async () => {
  let releaseCompact;
  let compactCalls = 0;
  const h = buildHarness({
    hostCall: async (method) => {
      if (method === "session.get") return { session: { id: "s1", compactionRecordId: "c0" } };
      return {};
    },
    sidecarCall: async (method) => {
      if (method === "agent.compact") {
        compactCalls += 1;
        await new Promise((resolve) => { releaseCompact = resolve; });
        return { ok: true };
      }
      if (method === "agent.abort") return { ok: true };
      throw new Error(`unexpected sidecar call: ${method}`);
    },
  });

  const first = compact(h, { sessionId: "s1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseCompact, "function", "the first compaction is pending");

  // The duplicate must be refused inside the locked admission — it must not
  // reach the sidecar, and its failure path must not clear the first
  // compaction's mark (issue #2289 re-review).
  await assert.rejects(
    compact(h, { sessionId: "s1" }),
    (error) => error.errorCode === ErrorCodes.AGENT_BUSY &&
      /already compacting/.test(error.message),
  );
  assert.equal(compactCalls, 1, "the sidecar saw only the first compaction");

  // The first compaction still guards admission for prompts.
  const guarded = await prompt(h, { sessionId: "s1", content: "hello" }).catch(
    (error) => error,
  );
  assert.equal(guarded.errorCode, ErrorCodes.AGENT_BUSY);
  assert.match(guarded.message, /compacting/);

  // Stop still cancels the pending compaction while the mark holds.
  const stopped = await abort(h, { sessionId: "s1" });
  assert.deepEqual(stopped, { ok: true });

  releaseCompact();
  await first;

  // Ownership released only by the owning call: prompts pass admission again.
  const admitted = await prompt(h, { sessionId: "s1", content: "hello" }).catch(
    (error) => error,
  );
  assert.match(admitted.message, /sentinel/);
});
