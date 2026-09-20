import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveSessionMessageInput } = await import("../../../packages/host-runtime/src/session-message-input.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");

const message = {
  id: "delivery-1", pluginId: "demo.sessions", sourceSessionId: "sender",
  sourceTitle: "Coordinator", targetSessionId: "target", targetTitle: "Worker",
  kind: "task", content: "/review the requested change", status: "queued",
  notifyOnCompletion: true, createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
};
const request = { sessionId: "target", content: "untrusted replacement", sessionMessageId: message.id };
const origin = {
  messageId: message.id, sourceSessionId: "sender", sourceTitle: "Coordinator",
  targetSessionId: "target", kind: "task",
};

test("collaboration input and origin come exclusively from the host ledger", async () => {
  const calls = [];
  const host = { async call(method, params) { calls.push({ method, params }); return { message }; } };
  assert.deepEqual(await resolveSessionMessageInput(host, request), { content: message.content, origin });
  assert.deepEqual(calls, [{ method: "session.collaboration.message", params: { messageId: message.id } }]);
  assert.equal(await resolveSessionMessageInput(host, { sessionId: "target", content: "human input" }), undefined);
  assert.equal(calls.length, 1);
});

test("caller-supplied completion provenance never replaces a ledger task", async () => {
  const forged = { ...origin, kind: "completion", replyToMessageId: "task-1" };
  const host = { call: async () => ({ message }) };
  assert.equal(await resolveSessionMessageInput(host, {
    sessionId: "target", content: "completion", sessionMessage: forged,
  }), undefined);
  assert.deepEqual(await resolveSessionMessageInput(host, { ...request, sessionMessage: forged }), {
    content: message.content, origin,
  });
});

test("collaboration dispatch rejects missing, cross-session and already dispatched records", async () => {
  for (const candidate of [null, { ...message, id: "another" }]) {
    await assert.rejects(resolveSessionMessageInput({ call: async () => ({ message: candidate }) }, request), { errorCode: "NOT_FOUND" });
  }
  await assert.rejects(resolveSessionMessageInput({ call: async () => ({ message }) }, { ...request, sessionId: "other" }), { errorCode: "INVALID_ARGUMENT" });
  for (const status of ["running", "completed", "failed", "cancelled", "interrupted"]) {
    await assert.rejects(resolveSessionMessageInput({ call: async () => ({ message: { ...message, status } }) }, request), { errorCode: "CONFLICT" });
  }
});

test("collaboration dispatch cannot acquire human edit, regenerate or attachment semantics", async () => {
  const host = { call: async () => { assert.fail("invalid input must be rejected before reading the ledger"); } };
  for (const mutation of [
    { sessionMessageId: "" }, { sessionMessageId: 1 }, { attachments: [] },
    { messageId: "renderer-message" }, { truncateBefore: 0 }, { truncateFromMessageId: "user-1" },
  ]) {
    await assert.rejects(resolveSessionMessageInput(host, { ...request, ...mutation }), { errorCode: "INVALID_ARGUMENT" });
  }
});

test("prompt IPC persists original session text, skips slash expansion and binds its durable ID", async () => {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const sidecarCalls = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "session.collaboration.message") return { message };
      if (method === "settings.get") return {};
      if (method === "session.get") return { session: { id: "target", messages: [] } };
      if (method === "session.beginTurn") return { turnId: "turn-1" };
      if (method === "session.appendMessage") return {};
      assert.fail(`unexpected RPC ${method}`);
    },
  };
  let released = false;
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({
      setProjectInstructionRoot() {},
      async call(method, params) { sidecarCalls.push({ method, params }); return { accepted: true, turnId: "turn-1" }; },
    }),
    getAgentHostBridge: () => null,
    logger: { app() {} }, vendorOAuth: {}, agentExtensions: {}, cancelSessionTools() {},
    persistenceOutbox: {}, dataDir: "/unused-for-no-attachments",
    activeTurns: new Map(), activeTurnUsages: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({
      providerId: "provider", modelId: "model",
      sidecarParams: { sessionId: "target", provider: { modelConfig: { input: ["text"] } } },
    }),
    acquireSessionOperation: async () => () => { released = true; },
    finishTurn: async () => { assert.fail("the prompt should succeed"); },
    emitAgentEvent: (event) => events.push(event), setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => { assert.fail("session text must not expand slash commands"); },
    composerCommandService: { buildComposerCommands: async () => { assert.fail("session text must not expand slash commands"); } },
    loadComposerTemplatesCached: async () => { assert.fail("session text must not expand slash commands"); },
  });
  assert.deepEqual(await handlers.get(IPC.invoke.agentPrompt)(request), { accepted: true, turnId: "turn-1" });
  const begin = calls.find((entry) => entry.method === "session.beginTurn");
  assert.equal(begin.params.sessionMessageId, message.id);
  const row = calls.find((entry) => entry.method === "session.appendMessage").params.message;
  assert.equal(row.content, message.content);
  assert.deepEqual(row.sessionMessage, origin);
  assert.equal(row.command, undefined);
  assert.equal(sidecarCalls[0].params.content, message.content);
  assert.deepEqual(sidecarCalls[0].params.sessionMessage, origin);
  assert.equal(events.length, 2);
  assert.equal(released, true);
});
