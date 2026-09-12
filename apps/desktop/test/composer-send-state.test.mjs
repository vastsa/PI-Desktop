import {
  readStoreSource,
  readStoreModule,
  readComposerSource,
  readComposerModule,
  readMainSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  store,
  composer,
  main,
  attachments,
  appStore,
  sessionSlice,
  sessionRuntime,
  sessionCoordination,
  eventsSlice,
  queueSlice,
  transcriptSlice,
  toolbar,
  submitHook,
  draftHook,
] = await Promise.all([
  readStoreSource(),
  readComposerSource(),
  readMainSource(),
  read("../electron/main/prompt-attachments.ts"),
  readStoreModule("app-store.ts"),
  readStoreModule("slices/session-slice.ts"),
  readStoreModule("runtime/session-runtime.ts"),
  readStoreModule("runtime/session-coordination.ts"),
  readStoreModule("slices/events-slice.ts"),
  readStoreModule("slices/queue-slice.ts"),
  readStoreModule("slices/transcript-slice.ts"),
  readComposerModule("ComposerToolbar.tsx"),
  readComposerModule("hooks/useComposerSubmit.ts"),
  readComposerModule("hooks/useComposerDraft.ts"),
]);

test("composer send/stop button follows draft content and the visible session's run state", () => {
  const composerRight = toolbar.match(/<div className="composer-right">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
  // Plan mode widens the running condition: `runActive` folds an in-flight
  // plan execution into the session's own `isRunning`. The submit slot then
  // switches to Stop only when that session is running and the draft is empty.
  const submitSlot =
    composerRight.match(
      /\{runActive && !hasDraftContent \? \([\s\S]*?\) : \([\s\S]*?\)\}/,
    )?.[0] ?? "";
  assert.ok(submitSlot.length > 0, "single submit slot implementation not found");
  assert.match(submitSlot, /className="stop-btn"/);
  assert.match(submitSlot, /className="send-btn"/);
  assert.equal(
    (submitSlot.match(/className="(?:stop|send)-btn"/g) ?? []).length,
    2,
    "Stop and Send should be the two mutually exclusive branches of one slot",
  );
  assert.match(composer, /const runActive = isRunning \|\| executionActive;/);
  assert.match(composer, /const isRunning = useAppStore\(\(s\) => s\.isRunning\);/);
  assert.match(submitSlot, /stopGenerating/);
  assert.match(submitSlot, /onClick=\{\(\) => void abort\(\)\}/);
  assert.doesNotMatch(composerRight, /\{runActive \? \(/);
  const modelIndex = composerRight.indexOf("<ComposerModelPicker");
  const enhanceIndex = composerRight.indexOf("composer-enhance-btn");
  const submitIndex = Math.max(
    composerRight.indexOf('className="stop-btn"'),
    composerRight.indexOf('className="send-btn"'),
  );
  assert.ok(
    modelIndex >= 0 && modelIndex < enhanceIndex && enhanceIndex < submitIndex,
    "The enhancement action should sit between model selection and the submit slot",
  );
  const modelTrigger =
    composer.match(
      /className=\{`icon-btn composer-model-thinking-chip[\s\S]*?<\/button>/,
    )?.[0] ?? "";
  assert.ok(modelTrigger.length > 0, "model selector trigger not found");
  assert.match(modelTrigger, /<IconBot size=\{14\} \/>/);
  assert.doesNotMatch(modelTrigger, /IconSparkles/);
  assert.doesNotMatch(
    composerRight,
    /className="stop-btn"[\s\S]*?\) : null\}[\s\S]*?className="send-btn"/,
    "Stop must not render beside an always-present Send button",
  );
  assert.match(composer, /const inputBlocked = approvalPending \|\| pasting;/);
  assert.match(composer, /const controlsBlocked = approvalPending;/);
  assert.match(composer, /contentEditable=\{!inputBlocked\}/);
  assert.match(composer, /disabled=\{controlsBlocked\}/);
  assert.match(composer, /sendBlocked[\s\S]*\(!modelReady/);
  assert.doesNotMatch(composer, /const inputBlocked = [^;]*runActive/);
});

test("running session configuration is queued for the next turn", () => {
  assert.match(store, /pendingSessionConfigurations = new Map/);
  assert.match(
    sessionSlice,
    /get\(\)\.runningSessions\[sessionId\][\s\S]*runtime\.pendingSessionConfigurations\.set\(\n\s*sessionId,\n\s*runtime\.mergeSessionConfiguration\(\n\s*runtime\.pendingSessionConfigurations\.get\(sessionId\),\s*config,\n\s*\),\n\s*\)/,
  );
  assert.match(sessionSlice, /applyOptimisticSessionConfiguration\(session, config\)/);
  assert.match(eventsSlice, /event\.type === "agent_end"[\s\S]*flushPendingSessionConfiguration\(envelope\.sessionId\)/);
});

test("running prompts use a removable per-session FIFO queue", () => {
  assert.match(store, /queuedPrompts: QueuedPrompts/);
  assert.match(store, /enqueueQueuedPrompt\(state\.queuedPrompts, item\)/);
  assert.match(store, /prioritizeQueuedPrompt\(/);
  // The Host owns the queue (D375 / D386): the renderer pushes through the
  // agent/queue channels and mirrors the durable entries after agent_end.
  assert.match(store, /api\s*\.queuePrompt\(/);
  assert.match(store, /api\.prioritizeQueuedPrompt\(promptId\)/);
  assert.match(store, /event\.type === "agent_end"[\s\S]*refreshQueuedPrompts\(envelope\.sessionId\)/);
  assert.doesNotMatch(store, /drainQueuedPrompts/);
  assert.match(composer, /data-testid="queued-prompt"/);
  assert.match(composer, /removeQueuedPrompt\(item\.id\)/);
  assert.match(composer, /sendQueuedNow\(item\.id\)/);
  assert.match(composer, /approvalPending[\s\S]*item\.sendNowRequested/);
});

test("new task persists or reuses an empty session and keeps the run flag scoped", () => {
  const newSession = sessionSlice.match(
    /newSession: async [\s\S]*?\n    forkSession: async/,
  )?.[0] ?? "";
  assert.ok(newSession.length > 0, "newSession implementation not found");
  assert.match(newSession, /latestSessionInScope/);
  assert.match(newSession, /sessionIsReusableEmpty/);
  assert.match(newSession, /persistSessionAndSelect/);
  assert.match(newSession, /pendingNewSessionRequests/);
  assert.doesNotMatch(newSession, /refreshSessions/);
  // A newly selected empty session uses its own run state, so a turn still
  // streaming in the previous session cannot leave it stuck on the stop
  // button.
  assert.match(
    sessionCoordination,
    /async function persistSessionAndSelect[\s\S]*?\n    return sessionId;\n  }\n/,
  );
  assert.match(
    sessionCoordination,
    /isRunning: current\.runningSessions\[summary\.id\] \?\? false/,
  );
});

test("cross-session agent_end cannot clear the active session's running flag", () => {
  const handleEvents = eventsSlice.slice(
    eventsSlice.indexOf("handleAgentEvent: (envelope) => {"),
  );
  assert.match(handleEvents, /envelope\.sessionId !== get\(\)\.activeSessionId/);
  // The cross-session branch returns before the active-session switch that
  // sets `isRunning: false` on agent_end, so only the session-scoped
  // runningSessions entry is updated for other sessions.
  const crossSession = handleEvents.match(
    /if \(envelope\.sessionId !== get\(\)\.activeSessionId\) \{[\s\S]*?\n    \}/,
  )?.[0] ?? "";
  assert.ok(crossSession.length > 0);
  assert.match(crossSession, /return;/);
  const agentEnd = handleEvents.match(/case "agent_end":\s*set\(\{ isRunning: false \}\)/);
  assert.ok(agentEnd, "active-session agent_end clears isRunning");
});

test("send clears the composer before the round trip and restores a rejected draft (D287)", () => {
  const submit = submitHook.match(
    /const submit = async \(\) => \{[\s\S]*?\n  \};/,
  )?.[0] ?? "";
  assert.ok(submit.length > 0, "composer submit implementation not found");
  // The DOM value is the source of truth for what gets sent: a state update
  // still pending under load must not drop the last characters typed.
  assert.match(
    submit,
    /const text = draft\.ref\.current \? readEditorValue\(draft\.ref\.current\) : value;/,
  );
  assert.match(submit, /serializeInlineComposerFileReferences\(\s*text,\s*activeFileReferences,\s*\)/);
  // Blocked and not-ready states are said, not swallowed.
  assert.match(submit, /if \(pasting\) showToast\(t\("chat\.pasteInProgress"\)/);
  assert.match(
    submit,
    /if \(!modelReady\) \{\s*showToast\(t\("errors\.MODEL_NOT_CONFIGURED"\), \{ variant: "error" \}\);\s*return;\s*\}/,
  );
  // Optimistic clear, restore on rejection. The clear must precede the await.
  const clearAt = submit.indexOf("draft.clearDraftForKey(submittedDraftKey);\n    const accepted = await sendPrompt(inlineContent, submittedDraft);");
  assert.ok(clearAt > 0, "draft must be cleared before awaiting sendPrompt");
  assert.match(submit, /if \(!accepted\) draft\.restoreDraftForKey\(submittedDraftKey, submittedDraft\);/);
  assert.doesNotMatch(submit, /if \(accepted\) draft\.clearDraftForKey\(submittedDraftKey\);\s*\};/);
  const restore = draftHook.match(
    /const restoreDraftForKey = \(key: string, snapshot: ComposerDraftSnapshot\) => \{[\s\S]*?\n  \};/,
  )?.[0] ?? "";
  assert.ok(restore.length > 0, "restoreDraftForKey not found");
  // Text typed after the failed send wins; a session the user left keeps the
  // draft in its cache slot for the next switch back.
  assert.match(restore, /if \(valueRef\.current\.trim\(\)\) return;/);
  assert.match(restore, /if \(currentKey !== key\) \{[\s\S]*?writeComposerDraft\(key, snapshot\);/);
  assert.match(restore, /setValue\(snapshot\.text\);/);
  assert.match(restore, /setCursor\(snapshot\.text\.length\);/);
});

test("mode slash prefixes send the trailing prompt and retain failed drafts", () => {
  const submit = submitHook.match(
    /const submit = async \(\) => \{[\s\S]*?\n  \};/,
  )?.[0] ?? "";
  assert.ok(submit.length > 0, "composer submit implementation not found");
  assert.match(submit, /const commandBody =/);
  assert.match(submit, /const isModeCommand =/);
  assert.match(
    submit,
    /if \(isModeCommand && commandBody\)[\s\S]*?await runPaletteCommand\(command\.id\);[\s\S]*?const accepted = await sendPrompt\([\s\S]*?draft\.draftSnapshot\(visibleCommandBody\)[\s\S]*?if \(accepted\) draft\.clearDraftForKey\(submittedDraftKey\);/,
  );
  assert.match(
    submit,
    /serializeInlineComposerFileReferences\(\s*visibleCommandBody,\s*activeFileReferences,\s*\)/,
  );
  assert.match(
    submit,
    /const submittedDraft = draft\.draftSnapshot\(text\);\s*draft\.clearDraftForKey\(submittedDraftKey\);\s*const accepted = await sendPrompt\(inlineContent, submittedDraft\);\s*if \(!accepted\) draft\.restoreDraftForKey\(submittedDraftKey, submittedDraft\);/,
  );
  assert.match(store, /draft\?: ComposerDraftSnapshot/);
  const sendPrompt = queueSlice.slice(
    queueSlice.indexOf("sendPrompt: async (content, draft, requestedSessionId)"),
  );
  assert.match(sendPrompt, /return false;/);
  assert.match(
    sendPrompt,
    /await api\.prompt\(\{[\s\S]*?sessionId,[\s\S]*?content,[\s\S]*?attachments:[\s\S]*?promptAttachmentsFromDraft\(draft\.fileReferences\)[\s\S]*?\}\);[\s\S]*?return true;/,
  );
});

test("draft attachment routing keeps image chips structured and file chips textual", () => {
  const helperSource = appStore.match(
    /function promptAttachmentsFromDraft\([\s\S]*?\n\}\n\nfunction promptAttachmentsFromMessage/,
  )?.[0]?.replace(/\n\nfunction promptAttachmentsFromMessage[\s\S]*$/, "");
  assert.ok(helperSource, "prompt attachment mapper not found");
  const executable = helperSource.replace(
    /function promptAttachmentsFromDraft\(\s*references: ComposerDraftSnapshot\["fileReferences"\],\s*\): AgentPromptAttachment\[\] \{/,
    "function promptAttachmentsFromDraft(references) {",
  );
  const promptAttachmentsFromDraft = new Function(
    `${executable}; return promptAttachmentsFromDraft;`,
  )();
  const attachments = promptAttachmentsFromDraft([
    {
      path: "/tmp/photo.png",
      name: "photo.png",
      kind: "image",
      mimeType: "image/png",
      token: "\uE001",
    },
    {
      path: "/tmp/notes.txt",
      name: "notes.txt",
      kind: "file",
      token: "\uE002",
    },
    {
      path: "src/legacy.jpg",
      name: "legacy.jpg",
      token: "\uE003",
    },
    { path: "src/index.ts", name: "index.ts", kind: "file" },
  ]);
  assert.deepEqual(attachments, [
    {
      path: "/tmp/photo.png",
      name: "photo.png",
      kind: "image",
      mimeType: "image/png",
    },
    {
      path: "src/legacy.jpg",
      name: "legacy.jpg",
      kind: "image",
    },
    { path: "src/index.ts", name: "index.ts", kind: "file" },
  ]);
});

test("the user row is inserted before the host round trip and echoed under the same id (D288)", () => {
  const sendPrompt = queueSlice.slice(
    queueSlice.indexOf("sendPrompt: async (content, draft, requestedSessionId)"),
  );
  assert.ok(sendPrompt.length > 0, "sendPrompt not found");
  const insertAt = sendPrompt.indexOf("insertOptimisticUserMessage(startedIn, optimisticMessage)");
  const promptAt = sendPrompt.indexOf("await api.prompt({");
  assert.ok(insertAt > 0, "sendPrompt should insert the optimistic user row");
  assert.ok(promptAt > insertAt, "the row must be on screen before api.prompt is awaited");
  assert.match(
    sendPrompt.slice(promptAt),
    /await api\.prompt\(\{[^}]*messageId: optimisticMessage\.id/,
    "the renderer id travels with the prompt so the host echo lands on the same row",
  );
  // The row is withdrawn when the send never reached the host, but only the
  // renderer's own object: a durable echo under the same id stays.
  assert.match(sendPrompt, /catch \(error\) \{\s*runtime\.submittedComposerDrafts\.delete\(startedIn\);\s*runtime\.retractOptimisticUserMessage\(startedIn, optimisticMessage\);/);
  assert.match(sessionRuntime, /function retractOptimisticUserMessage[\s\S]*?current\.messages\.includes\(message\)/);
  // A background session receives the row through its renderer cache.
  assert.match(sessionRuntime, /function insertOptimisticUserMessage[\s\S]*?upsertLiveSessionMessage\(cached, message\)/);
  // Edit-resend shows the rewritten prompt in place of the old row the same way.
  const editUserMessage = transcriptSlice.slice(
    transcriptSlice.indexOf("editUserMessage: async"),
  );
  assert.match(editUserMessage, /messages: \[\.\.\.kept, optimisticMessage\]/);
  assert.match(editUserMessage, /messageId: optimisticMessage\.id/);
  // The host persists and echoes under the renderer's id when it is a fresh UUID.
  assert.match(
    main,
    /id: durableUserMessageId\(\s*req\.messageId,\s*Array\.isArray\(session\.messages\)\s*\?\s*session\.messages\s*:\s*\[\],\s*\)/,
  );
  assert.match(attachments, /export function durableUserMessageId\([\s\S]*?UUID_PATTERN\.test\(requested\)[\s\S]*?!existing\.some\(\(message\) => message\?\.id === requested\)/);
});
