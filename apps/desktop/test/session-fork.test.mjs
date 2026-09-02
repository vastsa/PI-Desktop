import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("session fork is wired through protocol, main, API, store, and sidebar", () => {
  const protocol = read("../../../packages/shared/src/protocol.ts");
  const main = read("../electron/main/index.ts");
  const api = read("../src/lib/api.ts");
  const store = read("../src/stores/app-store.ts");
  const sidebar = read("../src/components/Sidebar.tsx");

  assert.match(
    protocol,
    /sessionFork:\s*"pi-desktop\/session\/fork"/,
  );
  assert.match(protocol, /PROTOCOL_VERSION = 10/);
  assert.match(main, /handle\(\s*IPC\.invoke\.sessionFork,/);
  assert.match(main, /activeTurns\.has\(sessionId\)/);
  assert.match(main, /"session\.fork"/);
  assert.match(
    api,
    /forkSession:\s*\(sessionId: string, title\?: string, throughMessageId\?: string\)/,
  );
  assert.match(store, /forkSession:\s*async \(id\)/);
  assert.match(store, /commitForkedSession\(result\.session/);
  assert.match(sidebar, /data-action="fork-session"/);
  assert.match(sidebar, /disabled=\{Boolean\(runningSessions\[session\.id\]\)\}/);
  assert.match(sidebar, /<IconBranch size=\{14\} \/>/);
  assert.match(sidebar, /\[role="menuitem"\]:not\(:disabled\)/);
});

test("assistant response fork reuses isolated session snapshots", () => {
  const main = read("../electron/main/index.ts");
  const store = read("../src/stores/app-store.ts");
  const transcript = read("../src/components/ChatTranscript.tsx");

  assert.match(main, /throughMessageId/);
  assert.match(store, /forkAssistantMessage:\s*async \(messageId\)/);
  assert.match(store, /api\.forkSession\([\s\S]*?messageId/);
  assert.match(transcript, /forkAssistantMessage\(actionMessage\.id\)/);
  assert.match(transcript, /chat\.forkResponse/);
});

test("session fork labels are localized", () => {
  const english = read("../../../packages/i18n/src/locales/en/index.ts");
  const chinese = read("../../../packages/i18n/src/locales/zh-CN/index.ts");

  assert.match(english, /createBranch:\s*"Branch from here"/);
  assert.match(english, /branchTitle:\s*"\{\{title\}\} \(branch\)"/);
  assert.match(chinese, /createBranch:\s*"从此处分支"/);
  assert.match(chinese, /branchTitle:\s*"\{\{title\}\}（分支）"/);
});

test("a fork is recorded even when a newer navigation took over (D-fork-msg-loss)", async () => {
  const { commitForkedSessionState, FORKED_SESSION_WINDOW, forkedSessionMessages } =
    await import("../src/lib/session-fork.ts");

  const current = {
    sessions: [{ id: "source" }],
    navStack: [{ page: "chat", sessionId: "source" }],
    navIndex: 0,
  };

  // The host already committed the child, so it must reach the sidebar whether
  // or not this fork still owns the view.
  const stale = commitForkedSessionState(current, { id: "child" }, { activate: false });
  assert.deepEqual(
    stale.sessions.map((session) => session.id),
    ["child", "source"],
    "a superseded fork must still list the child session",
  );
  assert.equal(stale.activated, false);
  assert.equal(stale.navStack, current.navStack, "a superseded fork records no history entry");
  assert.equal(stale.navIndex, current.navIndex);

  const active = commitForkedSessionState(current, { id: "child" }, { activate: true });
  assert.deepEqual(active.sessions.map((session) => session.id), ["child", "source"]);
  assert.equal(active.activated, true);
  assert.deepEqual(active.navStack.at(-1), { page: "chat", sessionId: "child" });
  assert.equal(active.navIndex, active.navStack.length - 1);

  // Re-forking the same id replaces the row instead of duplicating it.
  const again = commitForkedSessionState(
    { ...current, sessions: [{ id: "child" }, { id: "source" }] },
    { id: "child", title: "renamed" },
    { activate: true },
  );
  assert.equal(again.sessions.filter((session) => session.id === "child").length, 1);
  assert.equal(again.sessions[0].title, "renamed");

  // A fork response carries the child's whole transcript: the window is closed.
  assert.deepEqual(FORKED_SESSION_WINDOW, { messageStart: 0, hasMoreBefore: false });
  assert.deepEqual(forkedSessionMessages({ id: "child" }), []);
  assert.deepEqual(
    forkedSessionMessages({ id: "child", messages: [{ id: "m1" }] }).map((m) => m.id),
    ["m1"],
  );
});

test("fork actions commit the child through one durable helper", () => {
  const store = read("../src/stores/app-store.ts");

  // Both entry points must route through the helper that records the child
  // unconditionally and only makes activation depend on the navigation intent.
  const forkSessionBlock = store.slice(
    store.indexOf("forkSession: async (id)"),
    store.indexOf("forkAssistantMessage: async"),
  );
  assert.match(
    forkSessionBlock,
    /commitForkedSession\(result\.session,\s*\{\s*activate: navigationIntentIsCurrent\(intent\)/,
    "forkSession must record the child and gate only activation",
  );
  const forkAssistantBlock = store.slice(
    store.indexOf("forkAssistantMessage: async"),
    store.indexOf("configureActiveSession", store.indexOf("forkAssistantMessage: async")),
  );
  assert.match(
    forkAssistantBlock,
    /commitForkedSession\(result\.session,\s*\{\s*activate: navigationIntentIsCurrent\(intent\)/,
    "forkAssistantMessage must record the child and gate only activation",
  );
  // A bare early return on a stale intent is what dropped the branch before.
  assert.doesNotMatch(
    forkSessionBlock,
    /if \(!navigationIntentIsCurrent\(intent\)\) return;\s*const \{ messages/,
  );

  // The helper caches the transcript so re-selection paints from memory.
  const helper = store.slice(
    store.indexOf("function commitForkedSession"),
    store.indexOf("/** Append a freshly installed checkpoint"),
  );
  assert.match(helper, /cacheSessionTranscript\(summary\.id,\s*messages,\s*historyWindow\)/);
  assert.match(helper, /rememberSessionCompactions\(summary\.id,\s*session\)/);
});
