import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-mvp-"));
const output = join(temp, "fixture.mjs");
await build({
  stdin: { contents: `
    export { api } from './apps/desktop/src/lib/api';
    export { createRemoteHostWorkflow } from './apps/desktop/src/lib/remote-host-workflow';
    export { subscribeRemoteInteractions } from './apps/desktop/src/lib/remote-interactions';
    export { useAppStore } from './apps/desktop/src/stores/app-store';
    export { selectRemoteSession as selectRemote } from './apps/desktop/src/components/settings/RemoteHostSessions';
    export { sessionAllows, safeSessionSummary } from './apps/desktop/src/lib/remote-session-safety';
    export { sessionMatchesProject, projectPathsForNewSessions } from './apps/desktop/src/lib/sidebar-session-groups';
    export { visibleSettingsNav } from './apps/desktop/src/lib/settings-search';
    export { IPC } from '@pi-desktop/shared';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import i18n from 'i18next';
    import { initReactI18next } from 'react-i18next';
    import { remoteEn } from './apps/desktop/src/locales/remote';
    import { RemoteHostSessions } from './apps/desktop/src/components/settings/RemoteHostSessions';
    import { RemoteConversation } from './apps/desktop/src/components/remote/RemoteConversation';
    export async function render(kind, props) {
      await i18n.use(initReactI18next).init({lng:'en', fallbackLng:'en', resources:{en:{remote:remoteEn}}, interpolation:{escapeValue:false}});
      return renderToStaticMarkup(React.createElement(kind === 'host' ? RemoteHostSessions : RemoteConversation, props));
    }
  `, resolveDir: root, loader: "tsx" },
  outfile: output, bundle: true, platform: "node", format: "esm", jsx: "automatic",
  alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts") },
  loader: { ".css": "empty" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const fixture = await import(pathToFileURL(output).href);
const { api, createRemoteHostWorkflow, useAppStore, selectRemote, sessionAllows, safeSessionSummary, sessionMatchesProject, projectPathsForNewSessions, visibleSettingsNav, IPC } = fixture;
test.after(() => rm(temp, { recursive: true, force: true }));
const host = { hostKey: "ssh-fixture", label: "Build machine", transport: "ssh", connected: true, url: "ws://127.0.0.1:1" };
const capabilities = { canPrompt: true, canStop: true, canRefresh: true, canReadWorkspace: true, canConfigureModel: false, canAttach: false, canSteer: false, canEditMessages: false, canUseLocalTools: false, canUseTerminal: false };
const session = { id: "remote:ssh-fixture:one", source: "remote", remoteHostKey: host.hostKey, remoteHostLabel: host.label, remoteProjectId: "p1", remoteWorkspaceLabel: "Remote project", title: "Remote task", messageCount: 0, mode: "agent", permissionMode: "ask", thinkingLevel: "inherit", capabilities, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const provider = { id: "api-provider", name: "Network provider", enabled: true, type: "native", vendorKey: "openai", protocol: "openai", authKind: "api_key", hasSecret: true, hasOauth: false, models: [{ id: "remote-default" }] };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function bridge(handler) {
  const calls = [];
  globalThis.window = { piDesktop: { platform: "linux", on: () => () => {}, invoke: async (channel, ...args) => {
    calls.push({ channel, input: args[0] }); return { ok: true, data: await handler(channel, args[0]) };
  } } };
  return calls;
}
function initialize() {
  useAppStore.setState({ sessions: [], activeSessionId: undefined, selectingSessionId: undefined, messages: [], retainedSessionIds: [], retainedTranscripts: {}, sessionHistory: {}, sessionMeta: {}, runningSessions: {}, pendingPlans: {}, pendingPermissions: {}, pendingAsks: {}, planningStates: {}, providers: [provider], workPanelContexts: {}, workPanelTabs: [], activeWorkPanelTabId: null, workspace: { path: "/local/private", name: "Local only" }, activeProjectPath: "/local/private", page: "settings", settings: { defaultMode: "agent" } });
}
function defaultRead(channel) {
  if (channel === IPC.invoke.sessionGet) return { session: { ...session, messages: [] } };
  if (channel === IPC.invoke.plansPending) return { plans: [] };
  if (channel === IPC.invoke.notificationAcknowledgeSessionOutcome) return { ok: true };
  return {};
}

test("packaged non-developer Settings exposes experimental Remote Hosts", () => {
  const nav = visibleSettingsNav(false, false).find((item) => item.id === "remoteHosts");
  assert.ok(nav); assert.equal(nav.experimentalBadgeKey, "settings.remoteHosts.experimental");
});

test("host -> register absolute remote project -> create -> select real store conversation", async () => {
  initialize();
  const calls = bridge((channel, input) => {
    if (channel === IPC.invoke.remoteHostProjects) return { projects: [] };
    if (channel === IPC.invoke.remoteHostSessions) return { sessions: [] };
    if (channel === IPC.invoke.remoteHostRegisterProject) { assert.equal(input.path, "/srv/project"); return { project: { id: "p1", label: "Remote project", archived: false } }; }
    if (channel === IPC.invoke.remoteHostCreateSession) return { session: { ...session, projectPath: "/srv/project" } };
    return defaultRead(channel);
  });
  const workflow = createRemoteHostWorkflow(host, selectRemote);
  await workflow.load();
  await workflow.create({ projectId: "", path: "/srv/project", title: "Remote task" });
  assert.equal(workflow.getSnapshot().error, null);
  assert.equal(useAppStore.getState().activeSessionId, session.id);
  assert.equal(useAppStore.getState().page, "chat");
  assert.equal(useAppStore.getState().workspace.path, "/local/private");
  assert.equal(useAppStore.getState().sessions.find((item) => item.id === session.id).projectPath, undefined);
  const create = calls.find((call) => call.channel === IPC.invoke.remoteHostCreateSession);
  assert.deepEqual(create.input, { hostKey: host.hostKey, projectId: "p1", title: "Remote task", mode: "agent", permissionMode: "ask" });
  assert.ok(calls.findIndex((call) => call.channel === IPC.invoke.remoteHostRegisterProject) < calls.indexOf(create));
  assert.ok(!calls.some((call) => [IPC.invoke.projectActivate, IPC.invoke.projectClear, IPC.invoke.sessionConfigure].includes(call.channel)));
  workflow.dispose();
});

test("existing project selection does not register and closing during registration never creates/selects", async () => {
  initialize();
  const registration = deferred();
  const selected = [];
  const calls = bridge((channel) => {
    if (channel === IPC.invoke.remoteHostProjects) return { projects: [{ id: "p1", label: "Remote", archived: false }] };
    if (channel === IPC.invoke.remoteHostSessions) return { sessions: [session] };
    if (channel === IPC.invoke.remoteHostRegisterProject) return registration.promise;
    if (channel === IPC.invoke.remoteHostCreateSession) return { session };
  });
  const workflow = createRemoteHostWorkflow(host, async (value) => { selected.push(value); });
  await workflow.load();
  await workflow.create({ projectId: "p1", path: "", title: "" });
  assert.equal(selected.length, 1);
  assert.ok(!calls.some((call) => call.channel === IPC.invoke.remoteHostRegisterProject));
  const pending = workflow.create({ projectId: "", path: "/other", title: "" });
  workflow.dispose(); registration.resolve({ project: { id: "other", label: "Other", archived: false } });
  await pending;
  assert.equal(selected.length, 1);
  assert.equal(calls.filter((call) => call.channel === IPC.invoke.remoteHostCreateSession).length, 1);
});

test("sync starts unselected, requires fresh consent, rejects OAuth/direct host and sends IDs only", async () => {
  initialize();
  const calls = bridge((channel) => channel === IPC.invoke.remoteHostSyncProviders
    ? { imported: [{ sourceId: provider.id, providerId: "remote-provider" }], skipped: [], defaultSet: true } : {});
  const html = await fixture.render("host", { host, onClose() {} });
  assert.match(html, /API credentials will be copied/);
  const checkboxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);
  assert.equal(checkboxes.length, 2);
  assert.ok(!checkboxes[0].includes('checked=""'), "consent must start unchecked");
  const workflow = createRemoteHostWorkflow(host, async () => {});
  await workflow.sync([provider], [], false, true);
  await workflow.sync([provider], [provider.id], false, true);
  await workflow.sync([{ ...provider, hasOauth: true }], [provider.id], true, true);
  assert.equal(calls.length, 0);
  await workflow.sync([provider], [provider.id], true, true);
  assert.deepEqual(calls[0].input, { hostKey: host.hostKey, providerIds: [provider.id], setDefault: true });
  assert.equal(workflow.getSnapshot().syncResult.defaultSet, true);
  const direct = createRemoteHostWorkflow({ ...host, transport: "direct" }, async () => {});
  await direct.sync([provider], [provider.id], true, true);
  assert.equal(calls.length, 1);
  workflow.dispose(); direct.dispose();
});

test("reconnect failure remains visible; retry reloads inventory without resending mutations", async () => {
  let fail = true;
  const calls = bridge((channel) => {
    if (channel === IPC.invoke.remoteHostReconnect) { if (fail) throw new Error("SSH unavailable"); return { host }; }
    if (channel === IPC.invoke.remoteHostProjects) return { projects: [] };
    if (channel === IPC.invoke.remoteHostSessions) return { sessions: [session] };
  });
  const workflow = createRemoteHostWorkflow(host, async () => {});
  await workflow.reconnect(); assert.equal(workflow.getSnapshot().error, "SSH unavailable"); assert.equal(workflow.getSnapshot().busy, false);
  fail = false; await workflow.reconnect();
  assert.equal(workflow.getSnapshot().error, null); assert.equal(workflow.getSnapshot().sessions.length, 1);
  assert.ok(!calls.some((call) => [IPC.invoke.agentPrompt, IPC.invoke.remoteHostCreateSession, IPC.invoke.remoteHostSyncProviders].includes(call.channel)));
  workflow.dispose();
});

test("remote capabilities and workspace identity fail closed, local defaults stay enabled", async () => {
  initialize();
  assert.equal(sessionAllows(undefined, "canAttach"), true);
  for (const key of ["canAttach", "canConfigureModel", "canSteer", "canEditMessages", "canUseLocalTools", "canUseTerminal"]) {
    assert.equal(sessionAllows(session, key), false);
    assert.equal(sessionAllows({ ...session, capabilities: undefined }, key), false);
  }
  assert.equal(sessionMatchesProject({ ...session, projectPath: "/local/private" }, "/local/private"), false);
  assert.deepEqual(projectPathsForNewSessions([], [{ ...session, projectPath: "/srv/project" }]), []);
  assert.equal(safeSessionSummary({ ...session, projectPath: "/srv/project" }).projectPath, undefined);
  const calls = bridge(() => ({}));
  useAppStore.setState({ activeSessionId: session.id, sessions: [session], page: "chat" });
  await useAppStore.getState().configureActiveSession({ mode: "agent", providerId: "local-secret", modelId: "local-model" });
  await useAppStore.getState().forkSession(session.id);
  await useAppStore.getState().retryLastPrompt();
  assert.equal(await useAppStore.getState().editUserMessage("m", "edit"), false);
  assert.equal(await useAppStore.getState().steerPrompt("steer"), false);
  assert.equal(await useAppStore.getState().enqueuePrompt("queue"), false);
  useAppStore.getState().openFileInWorkPanel("/local/private/secret");
  useAppStore.getState().openUrlInWorkPanel("https://example.test");
  assert.equal(calls.length, 0);
  await assert.rejects(api.configureSession(session.id, { mode: "agent", modelId: "local" }), { code: "CAPABILITY_UNAVAILABLE" });
  await assert.rejects(api.prompt({ sessionId: session.id, content: "attached", attachments: [{ path: "/local/private" }] }), { code: "CAPABILITY_UNAVAILABLE" });
  assert.equal(calls.length, 0);
  const html = await fixture.render("chat", { session });
  assert.match(html, /Remote · Build machine · Remote project/);
  assert.doesNotMatch(html, /Local only|local\/private|composer-model|attachment-picker|plugin-slot|message-revision/);
});

test("session refresh retains the active remote identity when offline, and replaces it on recovery", async () => {
  initialize(); useAppStore.setState({ activeSessionId: session.id, sessions: [session] });
  let online = false;
  bridge((channel) => channel === IPC.invoke.sessionList ? { sessions: online ? [{ ...session, title: "Recovered" }] : [] } : {});
  await useAppStore.getState().refreshSessions();
  assert.equal(useAppStore.getState().sessions[0].source, "remote");
  online = true; await useAppStore.getState().refreshSessions();
  assert.equal(useAppStore.getState().sessions[0].title, "Recovered");
  assert.equal(useAppStore.getState().sessions.length, 1);
});

test("remote prompt and stop use routed APIs without local model configuration or transcript rewrites", async () => {
  initialize(); useAppStore.setState({ activeSessionId: session.id, sessions: [session], page: "chat" });
  const calls = bridge(defaultRead);
  assert.equal(await useAppStore.getState().sendPrompt("inspect the remote project", undefined, session.id), true);
  assert.equal(await useAppStore.getState().sendPrompt("do not queue", undefined, session.id), false);
  const prompt = calls.find((call) => call.channel === IPC.invoke.agentPrompt);
  assert.equal(prompt.input.sessionId, session.id);
  assert.equal(prompt.input.content, "inspect the remote project");
  assert.deepEqual(prompt.input.attachments, []);
  assert.equal(prompt.input.modelId, undefined);
  assert.equal(prompt.input.providerId, undefined);
  await useAppStore.getState().abort();
  assert.equal(useAppStore.getState().runningSessions[session.id], false);
  assert.ok(calls.some((call) => call.channel === IPC.invoke.agentAbort));
  assert.ok(!calls.some((call) => [IPC.invoke.sessionReplaceMessages, IPC.invoke.agentQueuePush, IPC.invoke.sessionConfigure, IPC.invoke.sessionDeriveTitle].includes(call.channel)));
});

test("remote Files and Review always send session identity and relative paths to the routed channels", async () => {
  initialize();
  const calls = bridge((channel) => {
    if (channel === IPC.invoke.fsList) return { entries: [{ name: "readme.md", kind: "file", size: 6 }] };
    if (channel === IPC.invoke.fsRead) return { kind: "text", content: "remote", size: 6 };
    if (channel === IPC.invoke.workspaceDiff) return { repo: true, clean: true, files: [] };
    throw new Error("Unexpected local filesystem operation");
  });
  assert.equal((await api.remoteWorkspaceList(session.id)).entries[0].name, "readme.md");
  assert.equal((await api.remoteWorkspaceRead(session.id, "readme.md")).content, "remote");
  assert.equal((await api.remoteWorkspaceDiff(session.id)).clean, true);
  assert.deepEqual(calls.map((call) => call.input), [{ sessionId: session.id, path: "" }, { sessionId: session.id, path: "readme.md" }, { sessionId: session.id }]);
});

test("a slow remote detail cannot replace a later selected conversation", async () => {
  initialize();
  const slow = deferred();
  const a = { ...session, id: "remote:ssh-fixture:slow" };
  const b = { ...session, id: "remote:ssh-fixture:fast" };
  useAppStore.setState({ sessions: [a, b] });
  bridge((channel, input) => {
    if (channel === IPC.invoke.sessionGet) return input.id === a.id ? slow.promise : { session: { ...b, messages: [] } };
    return defaultRead(channel);
  });
  const first = useAppStore.getState().selectSession(a.id);
  await useAppStore.getState().selectSession(b.id);
  slow.resolve({ session: { ...a, messages: [{ id: "late", role: "assistant", content: "stale", createdAt: a.createdAt }] } });
  await first;
  assert.equal(useAppStore.getState().activeSessionId, b.id);
  assert.ok(!useAppStore.getState().messages.some((message) => message.id === "late"));
  assert.equal(useAppStore.getState().workspace.path, "/local/private");
});

test("remote interaction IPC reconciles real queues and detaches without touching local prompts", () => {
  initialize();
  const permission = { requestId: `${session.id}#racp-approval:a`, sessionId: session.id, toolName: "Bash", reason: "Run command" };
  const ask = { requestId: "q", sessionId: session.id, questions: [] };
  const local = { ...permission, sessionId: "local", requestId: "local-permission" };
  useAppStore.setState({ pendingPermissions: { local: [local] } });
  const listeners = new Map();
  globalThis.window = { piDesktop: { on(channel, handler) { listeners.set(channel, handler); return () => listeners.delete(channel); } } };
  const unsubscribe = fixture.subscribeRemoteInteractions();
  const send = (event) => listeners.get(IPC.event.remoteInteractions)(event);
  const pending = { kind: "snapshot", sessionId: session.id, permissions: [permission], asks: [ask] };
  send(pending); send(pending);
  assert.deepEqual(useAppStore.getState().pendingPermissions[session.id], [permission]);
  assert.deepEqual(useAppStore.getState().pendingAsks[session.id], [ask]);
  send({ kind: "resolved", sessionId: session.id, requestKind: "permission", requestId: permission.requestId });
  assert.equal(useAppStore.getState().pendingPermissions[session.id], undefined);
  send({ ...pending, permissions: [], asks: [] });
  assert.equal(useAppStore.getState().pendingAsks[session.id], undefined);
  send({ ...pending, sessionId: "local", permissions: [], asks: [] });
  assert.deepEqual(useAppStore.getState().pendingPermissions.local, [local]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});
