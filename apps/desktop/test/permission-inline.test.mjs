import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clearSessionPermissions,
  enqueuePermission,
  headPermission,
  permissionSecondsLeft,
  queuedPermissionCount,
  removePermission,
  removePermissionForToolCall,
} from "../src/lib/pending-permissions.ts";
import {
  clearSessionAsks,
  enqueueAsk,
  headAsk,
  queuedAskCount,
  removeAsk,
  removeAskForToolCall,
} from "../src/lib/pending-asks.ts";
import { createNavigationIntentController } from "../src/lib/navigation-intent.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [appSource, chatSurfaceSource, sessionPaneSource, composerSource, transcriptSource, cardSource, askCardSource, storeSource, browserSource, messageStyleSource] =
  await Promise.all([
    read("../src/App.tsx"),
    read("../src/components/ChatSurface.tsx"),
    read("../src/components/SessionPane.tsx"),
    read("../src/components/Composer.tsx"),
    read("../src/components/ChatTranscript.tsx"),
    read("../src/components/PermissionCard.tsx"),
    read("../src/components/AskToolCard.tsx"),
    read("../src/stores/app-store.ts"),
    read("../src/components/workpanel/BrowserTab.tsx"),
    read("../src/styles/messages.css"),
  ]);

function permission(sessionId, requestId, extra = {}) {
  return {
    sessionId,
    requestId,
    toolCallId: `tool-${requestId}`,
    toolName: "Write",
    argsPreview: { path: `${sessionId}.txt` },
    risk: "high",
    reason: "Modify a workspace file",
    receivedAt: 1_000,
    ...extra,
  };
}

test("pending permissions stay isolated by session and request id", () => {
  const first = permission("session-a", "request-a");
  const second = permission("session-b", "request-b");
  const pending = enqueuePermission(
    enqueuePermission({}, first),
    second,
  );

  assert.deepEqual(Object.keys(pending).sort(), ["session-a", "session-b"]);
  assert.equal(
    removePermission(pending, "session-a", "stale-request"),
    pending,
  );

  const cleared = removePermission(pending, "session-a", "request-a");
  assert.equal(cleared["session-a"], undefined);
  assert.equal(headPermission(cleared, "session-b"), second);
});

test("parallel delegates queue behind the request on screen", () => {
  const first = permission("session-a", "request-first", {
    agentName: "explorer",
  });
  const second = permission("session-a", "request-second", {
    agentName: "test-runner",
  });
  const queues = enqueuePermission(enqueuePermission({}, first), second);

  assert.equal(headPermission(queues, "session-a"), first);
  assert.equal(queuedPermissionCount(queues, "session-a"), 1);
  // A duplicate delivery must not stack a second copy of the same request.
  assert.equal(enqueuePermission(queues, second), queues);

  const answered = removePermission(queues, "session-a", "request-first");
  assert.equal(headPermission(answered, "session-a"), second);
  assert.equal(queuedPermissionCount(answered, "session-a"), 0);
});

test("a finished tool call clears its request from anywhere in the queue", () => {
  const first = permission("session-a", "request-first");
  const second = permission("session-a", "request-second");
  const queues = enqueuePermission(enqueuePermission({}, first), second);

  // The host answers an expired request itself, so a queued card that was
  // never shown still has to leave the queue on `tool_end`.
  const afterExpiry = removePermissionForToolCall(
    queues,
    "session-a",
    "tool-request-second",
  );
  assert.equal(headPermission(afterExpiry, "session-a"), first);
  assert.equal(queuedPermissionCount(afterExpiry, "session-a"), 0);
  assert.equal(
    removePermissionForToolCall(queues, "session-a", "tool-unknown"),
    queues,
  );

  // Stopping the turn drops the whole queue, not just the visible request.
  const stopped = clearSessionPermissions(queues, "session-a");
  assert.equal(headPermission(stopped, "session-a"), undefined);
  assert.deepEqual(Object.keys(stopped), []);
});

test("a session with nothing pending keeps no empty queue", () => {
  const only = permission("session-a", "request-a");
  const queues = enqueuePermission({}, only);
  const emptied = removePermission(queues, "session-a", "request-a");

  assert.equal("session-a" in emptied, false);
  assert.equal(queuedPermissionCount(emptied, "session-a"), 0);
  assert.equal(headPermission(emptied, undefined), undefined);
});

test("asktool requests queue independently and never expire", () => {
  const first = {
    sessionId: "session-a",
    requestId: "ask-a",
    toolCallId: "tool-a",
    questions: [{ question: "Color?", options: ["Blue"] }],
  };
  const second = { ...first, requestId: "ask-b", toolCallId: "tool-b" };
  const queues = enqueueAsk(enqueueAsk({}, first), second);

  assert.equal(headAsk(queues, "session-a"), first);
  assert.equal(queuedAskCount(queues, "session-a"), 1);
  assert.equal(enqueueAsk(queues, second), queues);
  const next = removeAsk(queues, "session-a", "ask-a");
  assert.equal(headAsk(next, "session-a"), second);
  assert.equal(
    headAsk(removeAskForToolCall(next, "session-a", "tool-b"), "session-a"),
    undefined,
  );
  assert.deepEqual(Object.keys(clearSessionAsks(next, "session-a")), []);
});

test("asktool card is a stepwise, non-expiring composer question surface", () => {
  assert.match(chatSurfaceSource, /pendingAsk/);
  assert.match(composerSource, /<AskToolCard/);
  assert.match(composerSource, /headAsk\(s\.pendingAsks/);
  assert.doesNotMatch(transcriptSource, /AskToolCard/);
  // Each retained pane subscribes to its own session's ask queue (ADR 0136).
  assert.match(sessionPaneSource, /askPending=\{askPending\}/);
  assert.match(sessionPaneSource, /headAsk\(state\.pendingAsks, sessionId\)/);
  assert.match(storeSource, /event\.type === "asktool_request"/);
  assert.match(askCardSource, /current\.multiSelect/);
  assert.match(askCardSource, /customOption/);
  assert.match(askCardSource, /Decline all|askTool\.decline/);
  assert.match(askCardSource, /draft\.skipped/);
  assert.doesNotMatch(askCardSource, /permissionSecondsLeft|setInterval/);
  assert.match(messageStyleSource, /\.asktool-options[\s\S]*?overflow-y:\s*auto/);
  assert.match(messageStyleSource, /\.asktool-options[\s\S]*?max-height:\s*min\(320px,\s*36dvh\)/);
  assert.match(messageStyleSource, /\.asktool-options[\s\S]*?overscroll-behavior-y:\s*contain/);
});

test("permission countdown uses its absolute receipt time", () => {
  assert.equal(permissionSecondsLeft(1_000, 1_000), 120);
  assert.equal(permissionSecondsLeft(1_000, 61_001), 60);
  assert.equal(permissionSecondsLeft(1_000, 121_000), 0);
  assert.equal(permissionSecondsLeft(1_000, 180_000), 0);
});

test("permission approval is an inline transcript card, never a global dialog", () => {
  assert.doesNotMatch(appSource, /PermissionDialog/);
  assert.doesNotMatch(chatSurfaceSource, /PermissionDialog/);
  assert.doesNotMatch(appSource, /Boolean\(permission\)/);
  // The surface still needs the visible session's head request to decide
  // between the empty state and the panes; the card itself is rendered by the
  // pane that owns the session (ADR 0136).
  assert.match(chatSurfaceSource, /headPermission\(state\.pendingPermissions/);
  assert.match(
    sessionPaneSource,
    /pendingPermission=\{pendingPermission\}/,
  );
  assert.match(
    sessionPaneSource,
    /headPermission\(state\.pendingPermissions, sessionId\)/,
  );
  assert.match(transcriptSource, /key=\{pendingPermission\.requestId\}/);
  assert.match(transcriptSource, /permission=\{pendingPermission\}/);
  assert.doesNotMatch(cardSource, /className="overlay"|className="dialog"/);
  assert.doesNotMatch(cardSource, /role="alertdialog"/);
  assert.match(cardSource, /role="region"/);
  assert.match(cardSource, /disabled=\{resolving\}/);
  assert.match(cardSource, /requestAnimationFrame/);
  assert.match(cardSource, /showToast/);
  assert.doesNotMatch(cardSource, /<section[^>]*aria-live=/);
  assert.match(cardSource, /permissionSecondsLeft\(permission\.receivedAt\)/);
  assert.match(browserSource, /blocking overlay/);
  assert.doesNotMatch(browserSource, /permission dialog/);
});

test("the card names the delegate that asked and how many wait behind it", () => {
  assert.match(sessionPaneSource, /sessionPermissions\(/);
  assert.match(
    sessionPaneSource,
    /Math\.max\(0, sessionPermissions\(state\.pendingPermissions, sessionId\)\.length - 1\)/,
  );
  assert.match(
    sessionPaneSource,
    /queuedPermissions=\{queuedPermissions\}/,
  );
  assert.match(transcriptSource, /queued=\{queuedPermissions\}/);
  assert.match(cardSource, /t\("permission\.queued", \{ count: queued \}\)/);
  assert.match(
    cardSource,
    /t\("permission\.fromSubagent", \{ agent: permission\.agentName \}\)/,
  );
});

test("background permission events update only session-scoped state", () => {
  assert.match(
    storeSource,
    /pendingPermissions:\s*PermissionQueues/,
  );
  assert.doesNotMatch(storeSource, /permission\?:\s*ToolPermissionRequest/);
  const backgroundBlock = storeSource.match(
    /if \(envelope\.sessionId !== get\(\)\.activeSessionId\)[\s\S]*?return;/,
  )?.[0];
  assert.ok(backgroundBlock);
  assert.match(backgroundBlock, /enqueuePermission/);
  assert.doesNotMatch(
    backgroundBlock,
    /selectSession|activeSessionId:\s*|messages:\s*|page:\s*/,
  );
  assert.match(
    storeSource,
    /resolvePermission: async \(sessionId, requestId, decision\)/,
  );
  // Only the request on screen is answerable, and a late answer clears that
  // request alone rather than whatever now sits at the head.
  assert.match(storeSource, /headPermission\(get\(\)\.pendingPermissions, sessionId\)/);
  assert.match(
    storeSource,
    /removePermission\([\s\S]*state\.pendingPermissions,[\s\S]*sessionId,[\s\S]*requestId/,
  );
  assert.match(storeSource, /removePermissionForToolCall\(/);
  const abortBlock = storeSource.match(/abort: async[\s\S]*?\n  openProject:/)?.[0] ?? "";
  assert.match(abortBlock, /Promise\.allSettled/);
  assert.match(abortBlock, /decision: "deny"/);
  // Every open request is denied: a queued delegate would otherwise keep its
  // tool call alive past the stop the user asked for.
  assert.match(abortBlock, /sessionPermissions\(/);
  assert.match(abortBlock, /clearSessionPermissions\(/);
});

test("new navigation intents invalidate older asynchronous commits", async () => {
  const navigation = createNavigationIntentController();
  let releaseOlder;
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  const committed = [];

  const older = (async () => {
    const intent = navigation.begin();
    await olderGate;
    if (navigation.isCurrent(intent)) committed.push("older");
  })();
  const newerIntent = navigation.begin();
  if (navigation.isCurrent(newerIntent)) committed.push("newer");
  releaseOlder();
  await older;

  assert.deepEqual(committed, ["newer"]);
});

test("session and page navigation share the latest-intent guard", () => {
  assert.match(storeSource, /createNavigationIntentController/);
  assert.doesNotMatch(storeSource, /sessionSelectionQueue/);
  assert.match(storeSource, /let sessionWorkspaceQueue: Promise<void>/);
  assert.match(
    storeSource,
    /const detailPromise = loadSessionDetail\(id,\s*\{/,
  );
  assert.match(storeSource, /opts\?\.navigationIntent \?\? beginNavigationIntent\(\)/);
  assert.match(storeSource, /sessionWorkspaceQueue\.then/);
  assert.ok(
    storeSource.match(/navigationIntentIsCurrent\(intent\)/g)?.length >= 12,
    "navigation intent must be checked after asynchronous boundaries",
  );
  assert.match(storeSource, /setPage: \(page, opts\) => \{\s*beginNavigationIntent\(\)/);
  assert.match(storeSource, /activateProject: async \(path, opts\)/);
  assert.match(storeSource, /clearProject: async \(opts\)/);
});
