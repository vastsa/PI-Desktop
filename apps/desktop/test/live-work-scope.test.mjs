import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

async function loadScope(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  return server.ssrLoadModule("/electron/main/live-voice/work-scope.ts");
}

test("work scope requires the still-active call binding and a supported local session", async (t) => {
  const { requireSupportedWorkSession } = await loadScope(t);
  const bindings = new Map([["call-a", { workSessionId: "session-a" }]]);
  let lookups = 0;
  const host = {
    call: async () => {
      lookups += 1;
      return { sessions: [{ id: "session-a", source: "desktop" }] };
    },
  };

  assert.deepEqual(await requireSupportedWorkSession({ host, bindings, sessionId: "session-a", callId: "call-a" }), {
    id: "session-a",
    source: "desktop",
  });
  await assert.rejects(
    requireSupportedWorkSession({ host, bindings, sessionId: "session-a", callId: "call-b" }),
    { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" },
  );
  await assert.rejects(
    requireSupportedWorkSession({
      host: { call: async () => ({ sessions: [{ id: "session-a", source: "pi-native" }] }) },
      bindings,
      sessionId: "session-a",
      callId: "call-a",
    }),
    { errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED" },
  );
  await assert.rejects(
    requireSupportedWorkSession({
      host: { call: async () => ({ sessions: [{ id: "session-a", source: "remote" }] }) },
      bindings,
      sessionId: "session-a",
      callId: "call-a",
    }),
    { errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED" },
  );
  assert.equal(lookups, 1, "an invalid call binding is rejected before Host access");
});

test("work scope rejects a bound session after its workspace identity changes", async (t) => {
  const { requireSupportedWorkSession } = await loadScope(t);
  const bindings = new Map([[
    "call-a",
    { workSessionId: "session-a", workspaceIdentity: JSON.stringify(["project-a", "/workspace/a"]) },
  ]]);
  const host = {
    call: async () => ({ sessions: [{ id: "session-a", source: "desktop", projectId: "project-b", projectPath: "/workspace/b" }] }),
  };

  await assert.rejects(
    requireSupportedWorkSession({ host, bindings, sessionId: "session-a", callId: "call-a" }),
    { errorCode: "LIVE_WORK_SCOPE_CHANGED" },
  );
});

test("a work session removed while Host metadata is being read cannot pass revalidation", async (t) => {
  const { requireSupportedWorkSession } = await loadScope(t);
  const bindings = new Map([["call-a", { workSessionId: "session-a" }]]);
  let finishLookup;
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  const host = {
    call: () => new Promise((resolve) => {
      finishLookup = resolve;
      lookupStarted();
    }),
  };

  const validation = requireSupportedWorkSession({ host, bindings, sessionId: "session-a", callId: "call-a" });
  await started;
  bindings.delete("call-a");
  finishLookup({ sessions: [{ id: "session-a", source: "desktop" }] });
  await assert.rejects(validation, { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" });
});

test("selection references are opaque, call-scoped, short-lived, and removed with the call", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { LiveWorkSelectionRegistry } = await server.ssrLoadModule("/electron/main/live-voice/work-selections.ts");
  let now = 10;
  let nextId = 0;
  const registry = new LiveWorkSelectionRegistry(() => now, () => `ref-${++nextId}`);
  const options = registry.issue("call-a", 3, [
    { kind: "project", value: "/private/worktree/demo", label: "demo" },
    { kind: "project", value: "/private/worktree/other", label: "demo" },
  ], "create");

  assert.deepEqual(options, [
    { selectionRef: "ref-1", kind: "project", action: "create", label: "demo", duplicateLabel: true },
    { selectionRef: "ref-2", kind: "project", action: "create", label: "demo", duplicateLabel: true },
  ]);
  assert.equal(JSON.stringify(options).includes("/private/worktree"), false);
  assert.equal(registry.resolve({ callId: "call-b", workBindingRevision: 3, selectionRef: "ref-1" }), undefined);
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 4, selectionRef: "ref-1" }), undefined);
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 3, selectionRef: "ref-1" })?.value, "/private/worktree/demo");

  now += 60_000;
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 3, selectionRef: "ref-2" }), undefined);
  const next = registry.issue("call-a", 3, [{ kind: "project", value: "/private/worktree/new", label: "new" }], "none")[0];
  registry.removeCall("call-a");
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 3, selectionRef: next.selectionRef }), undefined);
});



test("live work backend port keeps prompt, stop, queue, and capability calls on each session source", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createLiveWorkBackendPort } = await server.ssrLoadModule("/electron/main/live-voice/live-work-backend-port.ts");
  const calls = [];
  const records = new Map([
    ["desktop-1", { id: "desktop-1", source: "desktop", title: "Desktop", mode: "agent" }],
    ["native-pi:1", { id: "native-pi:1", source: "pi-native", title: "Native", mode: "agent", canPrompt: true }],
    ["native-pi:readonly", { id: "native-pi:readonly", source: "pi-native", title: "Read only", mode: "agent", canPrompt: false, readOnlyReason: "read-only" }],
    ["remote:host:1", { id: "remote:host:1", source: "remote", title: "Remote", mode: "agent" }],
  ]);
  const bridge = {
    agentHost: {
      startTurn: async (principal, request) => { calls.push({ kind: "desktop-start", principal, request }); return { turn: { status: "running", id: "desktop-turn" } }; },
      enqueueTurn: async (principal, request) => { calls.push({ kind: "desktop-enqueue", principal, request }); return { turn: { id: "desktop-queue" } }; },
      workSnapshot: async (sessionId) => ({ sessionId, mode: "agent", state: "running", activeTurnId: "desktop-turn", queue: [] }),
    },
    stopWorkSession: async (request) => { calls.push({ kind: "desktop-stop", request }); return { status: "requested" }; },
    queue: {
      list: () => [{ id: "desktop-queue" }],
      remove: async (queueEntryId) => { calls.push({ kind: "desktop-cancel", queueEntryId }); },
    },
  };
  const sidecar = {
    onNotification: () => () => undefined,
    call: async (method, request) => {
      calls.push({ kind: "native", method, request });
      if (method === "agent.prompt") return { accepted: true, turnId: "native-turn" };
      if (method === "agent.abort") return { ok: true };
      if (method === "agent.getStatus") return { status: { isRunning: true, currentTurnId: "native-turn", pendingToolConfirmations: 0 } };
      throw new Error(`Unexpected sidecar method: ${method}`);
    },
  };
  let remoteOnline = true;
  const router = {
    resolveBackend: (channel) => remoteOnline ? ({
      invoke: async (actualChannel, args) => {
        calls.push({ kind: "remote", channel: actualChannel, args });
        if (actualChannel.endsWith("/agent/prompt")) return { accepted: true, turnId: "remote-turn" };
        if (actualChannel.endsWith("/agent/queue/push")) return { id: "remote-queue" };
        if (actualChannel.endsWith("/agent/stop")) return { requested: true };
        if (actualChannel.endsWith("/agent/queue/remove")) return { ok: true };
        if (actualChannel.endsWith("/agent/getStatus")) return { status: { isRunning: true, currentTurnId: "remote-turn", pendingToolConfirmations: 0 } };
        if (actualChannel.endsWith("/agent/queue/list")) return { entries: [{ id: "remote-queue", position: 1 }] };
        throw new Error(`Unexpected remote channel: ${actualChannel} via ${channel}`);
      },
    }) : null,
  };
  const port = createLiveWorkBackendPort({
    getHost: () => ({ call: async () => ({}) }),
    getSidecar: () => sidecar,
    getAgentHostBridge: () => bridge,
    getBackendRouter: () => router,
    getRemoteHosts: () => ({ listSessions: async () => [], subscribeSession: () => null }),
    requireSelectedSession: async (sessionId) => records.get(sessionId),
    requireCallScope: (callId, sessionId) => ({ workspaceIdentity: `${callId}:${sessionId}` }),
    observeTurnTarget: () => null,
  });
  const voiceOrigin = { callId: "call-a", operationId: "operation-a" };
  const submit = (sessionId) => port.submit({ sessionId, text: "fixture request", userMessageId: "message-a", voiceOrigin, idempotencyKey: `${sessionId}:key` });

  assert.deepEqual(await submit("desktop-1"), { status: "started", turnId: "desktop-turn" });
  assert.equal(calls.find((call) => call.kind === "desktop-start").request.expectedWorkspaceIdentity, "call-a:desktop-1");
  assert.deepEqual(await submit("native-pi:1"), { status: "started", turnId: "native-turn" });
  await assert.rejects(submit("native-pi:readonly"), { errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED" });
  assert.deepEqual(await submit("remote:host:1"), { status: "started", turnId: "remote-turn" });

  assert.deepEqual(await port.stop({ callId: "call-a", sessionId: "desktop-1", expectedTurnId: "desktop-turn", urgency: "graceful" }), { status: "requested" });
  assert.deepEqual(await port.stop({ callId: "call-a", sessionId: "native-pi:1", expectedTurnId: "native-turn", urgency: "immediate" }), {
    status: "requested",
    message: "Native Pi can only interrupt immediately; the selected turn was interrupted.",
  });
  assert.deepEqual(await port.stop({ callId: "call-a", sessionId: "remote:host:1", expectedTurnId: "remote-turn", urgency: "graceful" }), { status: "requested" });

  await port.enqueue({ sessionId: "desktop-1", text: "queued", userMessageId: "message-q", voiceOrigin, idempotencyKey: "desktop-q" });
  await port.enqueue({ sessionId: "remote:host:1", text: "queued", userMessageId: "message-q", voiceOrigin, idempotencyKey: "remote-q" });
  await assert.rejects(port.enqueue({ sessionId: "native-pi:1", text: "queued", userMessageId: "message-q", voiceOrigin, idempotencyKey: "native-q" }), { errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED" });
  assert.deepEqual(await port.cancelQueued({ callId: "call-a", sessionId: "desktop-1", queueEntryId: "desktop-queue" }), { status: "canceled" });
  assert.deepEqual(await port.cancelQueued({ callId: "call-a", sessionId: "remote:host:1", queueEntryId: "remote-queue" }), { status: "canceled" });
  assert.deepEqual(await port.cancelQueued({ callId: "call-a", sessionId: "native-pi:1", queueEntryId: "native-queue" }), { status: "unsupported" });

  assert.equal(calls.some((call) => call.kind === "remote" && call.channel.endsWith("/agent/prompt") && call.args[0].sessionId === "remote:host:1"), true);
  assert.equal(calls.some((call) => call.kind === "native" && call.method === "agent.prompt" && call.request.sessionId === "native-pi:1"), true);
  remoteOnline = false;
  await assert.rejects(submit("remote:host:1"), { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" });
});

test("initial Native Pi and Remote targets subscribe without a local AgentHost bridge", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createLiveWorkBridge } = await server.ssrLoadModule("/electron/main/live-voice/work-bridge.ts");
  const remoteSubscriptions = [];
  const nativeSubscriptions = [];
  const bridge = createLiveWorkBridge({
    getHost: () => ({ call: async () => ({ sessions: [] }) }),
    getAgentHostBridge: () => null,
    getSidecar: () => ({
      call: async () => ({}),
      onNotification: (listener) => { nativeSubscriptions.push(listener); return () => undefined; },
    }),
    getBackendRouter: () => null,
    getRemoteHosts: () => ({
      listSessions: async () => [],
      subscribeSession: (sessionId) => { remoteSubscriptions.push(sessionId); return () => undefined; },
    }),
    vendorOAuth: { resolveAuth: async () => "fixture-token" },
    navigateSession: async () => undefined,
    resolveAgentRuntimeLaunch: async () => { throw new Error("not used by an idle call"); },
    onOperation: () => undefined,
  });

  bridge.openCall({
    callId: "remote-call",
    workSessionId: "remote:host:session-1",
    workBindingRevision: 1,
    label: "Remote / Demo",
    sessionSource: "remote",
    contextEnabled: false,
  }, null);
  assert.deepEqual(remoteSubscriptions, ["remote:host:session-1"]);
  bridge.closeCall("remote-call");

  bridge.openCall({
    callId: "native-call",
    workSessionId: "native-pi:session-1",
    workBindingRevision: 1,
    label: "Native Pi / Demo",
    sessionSource: "pi-native",
    contextEnabled: false,
  }, null);
  assert.equal(nativeSubscriptions.length, 1);
  bridge.closeCall("native-call");
});

test("fresh live work catalog resolves Composer targets from all backends and rejects ambiguous IDs", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { listLiveWorkSessions, requireLiveWorkSession } = await server.ssrLoadModule("/electron/main/live-voice/live-work-backend-port.ts");
  const sessions = await listLiveWorkSessions({
    getHost: () => ({ call: async () => ({ sessions: [{ id: "desktop-1", source: "desktop", title: "Desktop", projectId: "project-1", projectPath: "/work/demo" }] }) }),
    getSidecar: () => ({ call: async () => ({ sessions: [{ id: "native-pi:1", title: "Native", capabilities: { canPrompt: true } }] }) }),
    getRemoteHosts: () => ({ listSessions: async () => [{ id: "remote-1", title: "Remote", hostLabel: "Office", workspaceLabel: "repo", mode: "agent" }] }),
  });

  assert.equal(requireLiveWorkSession(sessions, "desktop-1").source, "desktop");
  assert.equal(requireLiveWorkSession(sessions, "desktop-1").projectId, "project-1");
  assert.equal(requireLiveWorkSession(sessions, "native-pi:1").source, "pi-native");
  assert.equal(requireLiveWorkSession(sessions, "remote-1").source, "remote");
  const desktopSession = sessions.find((session) => session.id === "desktop-1");
  assert.ok(desktopSession);
  assert.throws(() => requireLiveWorkSession([...sessions, { ...desktopSession, source: "remote" }], "desktop-1"), {
    errorCode: "LIVE_WORK_SESSION_UNAVAILABLE",
  });
  assert.throws(() => requireLiveWorkSession(sessions, "missing"), { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" });
});
