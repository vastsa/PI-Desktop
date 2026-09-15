import { readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SIDE_CHAT_TAB_PREFIX,
  isSideChatTab,
  registerSideChat,
  removeSideChat,
  removeSideChatsForSessions,
  sideChatEntry,
  sideChatSessionIds,
  sideChatTabSessionId,
  sideChatsForParent,
  sideChatWorkPanelTab,
} from "../src/lib/side-chat.ts";
import { isKnownWorkPanelTab } from "../src/lib/work-panel-tabs.ts";

const store = await readStoreSource();
const panel = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const sideChatTab = await readFile(
  new URL("../src/components/workpanel/SideChatTab.tsx", import.meta.url),
  "utf8",
);
const transcript = await readTranscriptSource();

const entry = (sessionId, parentSessionId, createdAt, anchorMessageId) =>
  sideChatEntry({
    sessionId,
    parentSessionId,
    title: `Side chat: ${parentSessionId}`,
    createdAt,
    ...(anchorMessageId ? { anchorMessageId } : {}),
  });

test("a side-chat tab is keyed by its child session", () => {
  const tab = sideChatWorkPanelTab("child-1");
  assert.equal(tab.id, `${SIDE_CHAT_TAB_PREFIX}child-1`);
  assert.equal(tab.id, "sidechat:child-1");
  assert.equal(tab.kind, "sidechat");
  assert.equal(tab.resource, "child-1");
  assert.equal(isKnownWorkPanelTab(tab), true);
  assert.equal(sideChatTabSessionId(tab), "child-1");
  assert.equal(isSideChatTab(tab), true);
});

test("only side-chat tabs resolve to a child session", () => {
  assert.equal(sideChatTabSessionId({ id: "review", kind: "review" }), null);
  assert.equal(sideChatTabSessionId(null), null);
  assert.equal(
    sideChatTabSessionId({ id: "sidechat:", kind: "sidechat", resource: "  " }),
    null,
  );
});

test("registering and releasing a side chat keeps map identity stable", () => {
  const empty = {};
  const first = registerSideChat(empty, entry("child-1", "parent", 1));
  assert.deepEqual(sideChatSessionIds(first), ["child-1"]);
  assert.equal(removeSideChat(first, "missing"), first);
  assert.equal(removeSideChat(empty, "child-1"), empty);
  assert.deepEqual(removeSideChat(first, "child-1"), {});
});

test("deleting a session releases its own side chats and those opened from it", () => {
  const chats = registerSideChat(
    registerSideChat(
      registerSideChat({}, entry("child-1", "parent", 1)),
      entry("child-2", "other-parent", 2),
    ),
    entry("deep", "child-1", 3),
  );
  assert.deepEqual(
    sideChatSessionIds(removeSideChatsForSessions(chats, ["child-1"])).sort(),
    ["child-2"],
  );
  assert.deepEqual(
    sideChatSessionIds(removeSideChatsForSessions(chats, ["parent"])).sort(),
    ["child-2"],
  );
  assert.equal(removeSideChatsForSessions(chats, ["unrelated"]), chats);
});

test("side chats are listed for their own conversation, newest first", () => {
  const chats = registerSideChat(
    registerSideChat(
      registerSideChat({}, entry("older", "parent", 10)),
      entry("newer", "parent", 20),
    ),
    entry("elsewhere", "other-parent", 30),
  );
  assert.deepEqual(
    sideChatsForParent(chats, "parent").map((chat) => chat.sessionId),
    ["newer", "older"],
  );
  assert.deepEqual(sideChatsForParent(chats, undefined), []);
});

test("opening a side chat forks without activating and docks a panel tab", () => {
  assert.match(store, /openSideChat: async \(messageId\) => \{/);
  assert.match(store, /i18n\.t\("sideChat\.sessionTitle", \{ title: sourceTitle \}\)/);
  // The visible conversation must not be replaced by the child.
  assert.match(store, /commitForkedSession\(child, \{ activate: false, clearError: true \}\)/);
  assert.match(store, /registerSideChat\(/);
  assert.match(
    store,
    /get\(\)\.openWorkPanelTabForSession\(\s*parentSessionId,\s*sideChatWorkPanelTab\(child\.id\)/,
  );
  // One side chat per anchor message: re-opening reuses the existing child.
  assert.match(store, /sideChatsForParent\(state\.sideChats, parentSessionId\)\.find\(/);
  assert.match(panel, /<SideChatTab sessionId=\{sessionId\} \/>/);
  assert.match(panel, /if \(tab\.kind === "sidechat"\) return t\("sideChat\.title"\)/);
  assert.match(panel, /sidechat: IconChat,/);
});

test("a side chat streams through the shared background projection", () => {
  assert.match(store, /function projectTranscriptEvent\(/);
  assert.match(store, /function projectSideChatEvent\(envelope: AgentEventEnvelope\): void \{/);
  assert.match(store, /if \(!state\.sideChats\[envelope\.sessionId\]\) return;/);
  assert.match(store, /projectSideChatEvent\(envelope\);/);
  assert.match(store, /sideChatTranscripts: \{/);
});

test("closing the panel releases the side chat and keeps the child session", () => {
  assert.match(store, /const releasedSessionId = sideChatTabSessionId\(closedTab\)/);
  assert.match(store, /removeSideChat\(state\.sideChats, releasedSessionId\)/);
  assert.match(store, /closeSideChat: \(sessionId\) => \{/);
  // The child is durable: releasing never deletes the session.
  assert.doesNotMatch(
    store.slice(store.indexOf("closeSideChat: (sessionId) => {"), store.indexOf("addSideChatReplyToMain: (sessionId) =>")),
    /api\.deleteSession/,
  );
});

test("the panel can stop the child and quote its answer into the main chat", () => {
  assert.match(store, /abortSession: async \(sessionId\) => \{/);
  assert.match(store, /await api\.abort\(sessionId\)/);
  assert.match(sideChatTab, /abortSession\(sessionId\)/);
  assert.match(store, /addSideChatReplyToMain: \(sessionId\) => \{/);
  assert.match(store, /get\(\)\.quoteMessageIntoComposer\(\{ title: entry\.title, text: answer\.content \}\)/);
  // Send targets the child session and never the visible one.
  assert.match(sideChatTab, /sendPrompt\(\s*text,\s*\{ text, fileReferences: \[\] \},\s*sessionId,?\s*\)/);
  assert.match(sideChatTab, /t\("sideChat\.placeholder"\)/);
  assert.match(sideChatTab, /t\("sideChat\.empty"\)/);
});

test("promoting a side chat activates it and releases the panel entry", () => {
  assert.match(sideChatTab, /const openAsConversation = async \(\) => \{/);
  assert.match(sideChatTab, /closeSideChat\(sessionId\);\s*\n\s*await selectSession\(sessionId\)/);
});

test("a question from the child session is answerable inside the panel", () => {
  // The card resolves the request's own session id, so the docked panel can
  // answer the child without activating it.
  assert.match(sideChatTab, /<AskToolCard request=\{pendingAsk\} queued=\{queuedAsks\} \/>/);
  assert.match(sideChatTab, /askPending=\{Boolean\(pendingAsk\)\}/);
  assert.match(store, /resolveAsk: async \(sessionId, resolution: AskToolResolution\) => \{/);
});

test("the optimistic prompt row reaches an open side-chat panel", () => {
  const insert = store.slice(
    store.indexOf("function insertOptimisticUserMessage"),
    store.indexOf("function projectTranscriptEvent"),
  );
  assert.match(insert, /if \(state\.sideChatTranscripts\[sessionId\]\) \{/);
  const retract = store.slice(
    store.indexOf("function retractOptimisticUserMessage"),
    store.indexOf("function projectTranscriptEvent"),
  );
  assert.match(retract, /state\.sideChatTranscripts\[sessionId\]\?\.includes\(message\)/);
});

test("the docked transcript is a read-only projection of the child", () => {
  // Every row action resolves against the ACTIVE session, so a panel that
  // rendered them could re-page, truncate, or edit the visible conversation.
  assert.match(sideChatTab, /<TranscriptReadOnlyContext\.Provider value>/);
  assert.match(transcript, /export const TranscriptReadOnlyContext = createContext\(false\)/);
  assert.match(transcript, /const transcriptReadOnly = useContext\(TranscriptReadOnlyContext\)/);
  assert.match(transcript, /!editing && !transcriptReadOnly && \(hasAnswer \|\| showRevisionPager\)/);
  assert.match(transcript, /\(content \|\| hasError\) && actionMessage && !transcriptReadOnly/);
  // The panel owns one permission card, so the transcript must not add a second.
  assert.match(transcript, /\{pendingPermission && !transcriptReadOnly \? \(/);
});

test("the panel projection follows every event, even while the child is visible", () => {
  const callSites = store.match(/projectSideChatEvent\(envelope\);/g) ?? [];
  assert.equal(callSites.length, 1);
  // It must run before the cross-session early return, otherwise switching to the
  // child and back would leave a hole in the docked transcript.
  assert.ok(
    store.indexOf("projectSideChatEvent(envelope);") <
      store.indexOf("if (envelope.sessionId !== get().activeSessionId) {"),
  );
});

test("deleting a session strips its side-chat tab from every panel context", () => {
  const deletion = store.slice(
    store.indexOf("removeSideChatsForSessions(state.sideChats, [id])"),
  );
  assert.match(deletion, /const releasedTabIds = new Set\(/);
  assert.match(deletion, /const stripTabs = \(tabs: WorkPanelTab\[\]\) =>/);
  assert.match(deletion, /workPanelContexts = Object\.fromEntries\(/);
  assert.match(deletion, /workPanelTabs,/);
});

test("two clicks on one anchor share a single fork", () => {
  assert.match(store, /const sideChatOpens = new Map<string, Promise<string \| null>>\(\)/);
  assert.match(store, /const inFlight = sideChatOpens\.get\(openKey\);/);
  assert.match(store, /if \(inFlight\) return inFlight;/);
  assert.match(store, /sideChatOpens\.delete\(openKey\)/);
  // The tab docks into the parent's own context, not whichever session is
  // visible when the fork resolves.
  assert.match(store, /get\(\)\.openWorkPanelTabForSession\(\s*parentSessionId,\s*sideChatWorkPanelTab\(/);
  assert.doesNotMatch(store, /get\(\)\.openWorkPanelTab\(sideChatWorkPanelTab\(/);
});
