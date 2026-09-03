import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [store, composer] = await Promise.all([
  read("../src/stores/app-store.ts"),
  read("../src/components/Composer.tsx"),
]);

test("composer send/stop button follows draft content and the visible session's run state", () => {
  const composerRight = composer.match(/<div className="composer-right">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
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
  assert.match(
    composerRight,
    /composer-model-thinking-chip[\s\S]*composer-enhance-btn[\s\S]*className="(?:stop|send)-btn"/,
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
  assert.match(composer, /readOnly=\{inputBlocked\}/);
  assert.match(composer, /disabled=\{controlsBlocked\}/);
  assert.match(composer, /sendBlocked[\s\S]*\(!modelReady/);
  assert.doesNotMatch(composer, /const inputBlocked = [^;]*runActive/);
});

test("running session configuration is queued for the next turn", () => {
  assert.match(store, /pendingSessionConfigurations = new Map/);
  assert.match(
    store,
    /get\(\)\.runningSessions\[sessionId\][\s\S]*pendingSessionConfigurations\.set\(sessionId, config\)/,
  );
  assert.match(store, /event\.type === "agent_end"[\s\S]*flushPendingSessionConfiguration\(envelope\.sessionId\)/);
});

test("running prompts use a removable per-session FIFO queue", () => {
  assert.match(store, /queuedPrompts: QueuedPrompts/);
  assert.match(store, /enqueueQueuedPrompt\(state\.queuedPrompts, item\)/);
  assert.match(store, /prioritizeQueuedPrompt\(/);
  assert.match(store, /event\.type === "agent_end"[\s\S]*drainQueuedPrompts\(envelope\.sessionId\)/);
  assert.match(composer, /data-testid="queued-prompt"/);
  assert.match(composer, /removeQueuedPrompt\(item\.id\)/);
  assert.match(composer, /sendQueuedNow\(item\.id\)/);
  assert.match(composer, /approvalPending[\s\S]*item\.sendNowRequested/);
});

test("new task persists or reuses an empty session and keeps the run flag scoped", () => {
  const newSession = store.match(
    /newSession: async [\s\S]*?\n  forkSession: async/,
  )?.[0] ?? "";
  assert.ok(newSession.length > 0, "newSession implementation not found");
  assert.match(newSession, /latestSessionInScope/);
  assert.match(newSession, /latest\.messageCount === 0/);
  assert.match(newSession, /persistSessionAndSelect/);
  assert.match(newSession, /pendingNewSessionRequests/);
  // A newly selected empty session uses its own run state, so a turn still
  // streaming in the previous session cannot leave it stuck on the stop
  // button.
  assert.match(
    store,
    /async function persistSessionAndSelect[\s\S]*?\n  return sessionId;\n}\n/,
  );
  assert.match(
    store,
    /isRunning: s\.runningSessions\[sessionId\] \?\? false/,
  );
});

test("cross-session agent_end cannot clear the active session's running flag", () => {
  const handleEvents = store.match(
    /handleAgentEvent: \(envelope\) => \{[\s\S]*?\n  setPage:/,
  )?.[0] ?? "";
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
  const submit = composer.match(
    /const submit = async \(\) => \{[\s\S]*?\n  \};\n\n  const pasteClipboardFiles/,
  )?.[0] ?? "";
  assert.ok(submit.length > 0, "composer submit implementation not found");
  // The DOM value is the source of truth for what gets sent: a state update
  // still pending under load must not drop the last characters typed.
  assert.match(submit, /const text = ref\.current\?\.value \?\? value;/);
  assert.match(submit, /serializeInlineComposerFileReferences\(\s*text,\s*activeFileReferences,\s*\)/);
  // Blocked and not-ready states are said, not swallowed.
  assert.match(submit, /if \(pasting\) showToast\(t\("chat\.pasteInProgress"\)/);
  assert.match(
    submit,
    /if \(!modelReady\) \{\s*showToast\(t\("errors\.MODEL_NOT_CONFIGURED"\), \{ variant: "error" \}\);\s*return;\s*\}/,
  );
  // Optimistic clear, restore on rejection. The clear must precede the await.
  const clearAt = submit.indexOf("clearDraftForKey(submittedDraftKey);\n    const accepted = await sendPrompt(inlineContent, submittedDraft);");
  assert.ok(clearAt > 0, "draft must be cleared before awaiting sendPrompt");
  assert.match(submit, /if \(!accepted\) restoreDraftForKey\(submittedDraftKey, submittedDraft\);/);
  assert.doesNotMatch(submit, /if \(accepted\) clearDraftForKey\(submittedDraftKey\);\s*\};/);
  const restore = composer.match(
    /const restoreDraftForKey = \(key: string, snapshot: ComposerDraftSnapshot\) => \{[\s\S]*?\n  \};/,
  )?.[0] ?? "";
  assert.ok(restore.length > 0, "restoreDraftForKey not found");
  // Text typed after the failed send wins; a session the user left keeps the
  // draft in its cache slot for the next switch back.
  assert.match(restore, /if \(valueRef\.current\.trim\(\)\) return;/);
  assert.match(restore, /if \(currentKey !== key\) \{[\s\S]*?draftCacheRef\.current\.set\(key, snapshot\);/);
  assert.match(restore, /setValue\(snapshot\.text\);/);
  assert.match(restore, /setCursor\(snapshot\.text\.length\);/);
});

test("mode slash prefixes send the trailing prompt and retain failed drafts", () => {
  const submit = composer.match(
    /const submit = async \(\) => \{[\s\S]*?\n  \};\n\n  const composerAc/,
  )?.[0] ?? "";
  assert.ok(submit.length > 0, "composer submit implementation not found");
  assert.match(submit, /const commandBody =/);
  assert.match(submit, /const isModeCommand =/);
  assert.match(
    submit,
    /if \(isModeCommand && commandBody\)[\s\S]*?await runPaletteCommand\(command\.id\);[\s\S]*?const accepted = await sendPrompt\([\s\S]*?draftSnapshot\(visibleCommandBody\)[\s\S]*?if \(accepted\) clearDraftForKey\(submittedDraftKey\);/,
  );
  assert.match(
    submit,
    /serializeInlineComposerFileReferences\(\s*visibleCommandBody,\s*activeFileReferences,\s*\)/,
  );
  assert.match(
    submit,
    /const submittedDraft = draftSnapshot\(text\);\s*clearDraftForKey\(submittedDraftKey\);\s*const accepted = await sendPrompt\(inlineContent, submittedDraft\);\s*if \(!accepted\) restoreDraftForKey\(submittedDraftKey, submittedDraft\);/,
  );
  assert.match(store, /draft\?: ComposerDraftSnapshot/);
  const sendPrompt = store.match(
    /sendPrompt: async \(content, draft, requestedSessionId\)[\s\S]*?\n  compactContext:/,
  )?.[0] ?? "";
  assert.match(sendPrompt, /return false;/);
  assert.match(
    sendPrompt,
    /await api\.prompt\(\{[\s\S]*?sessionId,[\s\S]*?content,[\s\S]*?attachments:[\s\S]*?promptAttachmentsFromDraft\(draft\.fileReferences\)[\s\S]*?\}\);[\s\S]*?return true;/,
  );
});
