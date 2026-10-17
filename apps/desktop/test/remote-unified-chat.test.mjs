import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";

const remote = {
  id: "remote:host:session", source: "remote", remoteHostLabel: "Linux host",
  remoteWorkspaceLabel: "/srv/remote-app", title: "Remote task", messageCount: 0,
  mode: "agent", thinkingLevel: "off", permissionMode: "ask",
  capabilities: { canPrompt: true, canStop: true, canRefresh: true, canAttach: false, canUseLocalTools: false, canConfigureModel: false },
};

test("remote home and transcript use the regular composer without local workspace identity", async (t) => {
  const ssr = await slotSsr(t);
  globalThis.window = { piDesktop: { platform: "darwin" }, matchMedia: () => ({ matches: false }) };
  t.after(() => { delete globalThis.window; });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  Object.assign(useAppStore.getInitialState(), {
    sessions: [remote], activeSessionId: remote.id, retainedSessionIds: [remote.id],
    workspace: { path: "/local/app", name: "LOCAL MUST NOT APPEAR" }, messages: [],
  });
  const { ChatSurface } = await ssr.load("/src/components/ChatSurface.tsx");
  const home = ssr.render(createElement(ChatSurface), { sessionId: null });
  assert.match(home, /remote-app/);
  assert.doesNotMatch(home, /LOCAL MUST NOT APPEAR/);
  assert.match(home, /data-composer-dock="home"/);
  assert.doesNotMatch(home, /remote-conversation/);
  Object.assign(useAppStore.getInitialState(), {
    messages: [{ id: "u1", role: "user", content: "Remote question", createdAt: 1 }],
  });
  const transcript = ssr.render(createElement(ChatSurface), { sessionId: null });
  assert.match(transcript, /data-session-pane="remote:host:session"/);
  assert.match(transcript, /Remote question/);
  assert.match(transcript, /data-composer-dock="docked"/);
  assert.doesNotMatch(transcript, /aria-label="Edit message"|aria-label="Delete message"/);
});

test("remote toolbar preserves send and stop while disabling local controls and plugin slots", async (t) => {
  const ssr = await slotSsr(t);
  ssr.register("example", { slot: "composerControl", side: "left", component: () => createElement("span", null, "LOCAL PLUGIN") });
  const render = await composerToolbar(t, ssr, {
    localToolsAllowed: false, attachmentsAllowed: false, controlsBlocked: true,
    hasDraftContent: true, modelReady: true, workSessionId: remote.id,
  });
  const html = render();
  assert.doesNotMatch(html, /LOCAL PLUGIN/);
  assert.match(html, /aria-label="chat.addFiles"[^>]*disabled/);
  assert.match(html, /aria-label="chat.send"/);
  const stop = await composerToolbar(t, ssr, {
    localToolsAllowed: false, controlsBlocked: true, runActive: true, hasDraftContent: false,
    stopAllowed: false,
  });
  assert.match(stop(), /aria-label="chat.stopGenerating"[^>]*disabled/);
});

test("remote submission sends slash text unchanged and rejects steering without local command dispatch", async (t) => {
  const ssr = await slotSsr(t);
  const { useComposerSubmit } = await ssr.load("/src/features/chat/composer/hooks/useComposerSubmit.ts");
  const calls = [];
  const draft = {
    ref: { current: null }, draftRevision: () => 1,
    draftSnapshot: (text) => ({ text, fileReferences: [] }),
    clearDraftForKey: (...args) => calls.push(["clear", ...args]),
    restoreDraftForKey: (...args) => calls.push(["restore", ...args]),
  };
  const controller = useComposerSubmit({
    value: "/compact", draftKey: remote.id, activeSessionId: remote.id,
    modelReady: true, sendBlocked: false, localCommandsAllowed: false, steeringAllowed: false,
    invalidateComposerTransforms() {}, pasting: false, activeFileReferences: [],
    t: (key) => key, showToast() {}, draft,
    sendPrompt: async (text, snapshot, id) => { calls.push(["prompt", text, id]); return true; },
    steerPrompt: async () => { throw new Error("remote steering must remain blocked"); },
  });
  await controller.submit();
  assert.deepEqual(calls.find((call) => call[0] === "prompt"), ["prompt", "/compact", remote.id]);
  const before = calls.length;
  await controller.submit(true);
  assert.equal(calls.length, before);
});

test("remote Read/Write tool rows stay readable and retained panes cannot open local files or rollback", async (t) => {
  const ssr = await slotSsr(t);
  const calls = [];
  globalThis.window = {
    piDesktop: { platform: "darwin", invoke: async (...args) => { calls.push(args); throw new Error("remote must not call local host"); }, on: () => () => {} },
    matchMedia: () => ({ matches: false }),
  };
  t.after(() => { delete globalThis.window; });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const state = { sessions: [remote, { id: "local", title: "Local" }], activeSessionId: "local", workspace: { path: "/local/private" } };
  useAppStore.setState(state);
  Object.assign(useAppStore.getInitialState(), state);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { ReviewChangeCard } = await ssr.load("/src/components/ReviewChangeCard.tsx");
  const { TranscriptDisclosureProvider } = await ssr.load("/src/features/chat/transcript/disclosure.tsx");
  const tool = (toolName) => ({ id: toolName, role: "tool", toolName, toolStatus: "success", toolArgs: { path: "/srv/remote-app/README.md", content: "remote file" }, content: "done", createdAt: 1 });
  for (const toolName of ["Read", "Write"]) {
    const html = ssr.render(createElement(TranscriptDisclosureProvider, null, createElement(ToolRow, { message: tool(toolName) })), { sessionId: remote.id });
    assert.match(html, /README.md/);
    assert.doesNotMatch(html, /local\/private|pi-plugin-slot/);
  }
  const write = { ...tool("Write"), toolResult: { details: { root: "workspace", review: {
    version: 1, snapshotId: "remote-snapshot", messageId: "Write", path: "README.md", operation: "write", status: "modified", state: "applied", additions: 1, deletions: 0, reversible: true, hunks: [],
  } } } };
  const review = ssr.render(createElement(ReviewChangeCard, { message: write }), { sessionId: remote.id });
  assert.doesNotMatch(review, /review-change-rollback"/);
  const { useOpenPreviewTarget, useOpenChatFileRef } = await ssr.load("/src/hooks/use-preview-target.ts");
  let openTarget, openFile;
  function Probe() { openTarget = useOpenPreviewTarget(); openFile = useOpenChatFileRef(); return null; }
  ssr.render(createElement(Probe), { sessionId: remote.id });
  openTarget({ kind: "file", path: "/local/private/secret" });
  openTarget({ kind: "session", sessionId: "local" });
  await openFile("/local/private/secret");
  assert.deepEqual(calls, []);
  assert.equal(useAppStore.getState().activeSessionId, "local");
});

test("remote Markdown links remain copyable text and callbacks cannot open local URL targets", async (t) => {
  const ssr = await slotSsr(t, { plugins: [{ name: "markdown-callback-probe", transform(source, id) {
    if (id.endsWith("/components/Markdown.tsx")) return source + "\nexport { Anchor as ProbeAnchor, InlineCode as ProbeInlineCode };";
  } }] });
  const calls = [];
  globalThis.window = { piDesktop: { platform: "darwin", invoke: async (...args) => { calls.push(args); return { ok: true, data: {} }; } }, matchMedia: () => ({ matches: false }) };
  t.after(() => { delete globalThis.window; });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const state = { sessions: [remote], activeSessionId: remote.id, workspace: { path: "/local/private" }, openUrlInWorkPanel: (...args) => calls.push(args) };
  useAppStore.setState(state);
  Object.assign(useAppStore.getInitialState(), state);
  const { Markdown, ProbeAnchor, ProbeInlineCode } = await ssr.load("/src/components/Markdown.tsx");
  const html = ssr.render(createElement(Markdown, { source: "[Remote docs](https://example.test/docs) and `https://example.test/code`" }), { sessionId: remote.id });
  assert.match(html, /Remote docs/);
  assert.match(html, /https:\/\/example.test\/code/);
  assert.doesNotMatch(html, /href="https:|chat-code-link/);
  let onClick;
  function Probe() {
    const anchor = ProbeAnchor({ href: "https://example.test/docs", children: "Remote docs" });
    onClick = anchor.props.children[0].props.onClick;
    const code = ProbeInlineCode({ children: "https://example.test/code" });
    assert.equal(code.type, "code");
    return anchor;
  }
  ssr.render(createElement(Probe), { sessionId: remote.id });
  for (const modified of [false, true]) {
    let prevented = false;
    onClick({ metaKey: modified, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, "modifier links must not escape through native browser navigation");
  }
  assert.deepEqual(calls, []);
});
