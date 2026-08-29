import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [store, transcript, outcome, styles] = await Promise.all([
  read("../src/stores/app-store.ts"),
  read("../src/components/ChatTranscript.tsx"),
  read("../src/components/TurnOutcomeCard.tsx"),
  loadStyles(),
]);

test("terminal agent events retain a session-scoped result for the transcript", () => {
  assert.match(store, /latestTurnResults: Record<string, AgentTurnResult>/);
  assert.match(store, /status: event\.type === "error" \? "failed" : "completed"/);
  assert.match(store, /turnId:\s*\n\s*envelope\.turnId \?\?/);
  assert.match(store, /error\.code === "TURN_ABORTED"[\s\S]*?withoutRecordKey\(s\.latestTurnResults/);
  assert.match(transcript, /<TurnOutcomeCard[\s\S]*?result=\{latestTurnResult\}/);
});

test("outcome card exposes one localized continuation action", () => {
  const sendPrompt = store.slice(
    store.indexOf("sendPrompt: async"),
    store.indexOf("compactContext: async"),
  );
  assert.match(outcome, /data-testid="turn-outcome-card"/);
  assert.match(outcome, /result\.status === "completed"/);
  assert.doesNotMatch(outcome, /resultComplete/);
  assert.match(outcome, /resultNeedsAttention/);
  assert.match(outcome, /resultSteps/);
  assert.equal((outcome.match(/<button/g) ?? []).length, 1);
  assert.match(outcome, /sendPrompt\(t\("chat\.continueUnfinishedTaskPrompt"\)\)/);
  assert.match(outcome, /t\("chat\.resultContinue"\)/);
  assert.doesNotMatch(outcome, /retryLastPrompt/);
  assert.doesNotMatch(outcome, /focusComposer/);
  assert.doesNotMatch(outcome, /t\("chat\.retry"\)/);
  assert.doesNotMatch(outcome, /toolWorkPanelTab/);
  assert.match(sendPrompt, /await api\.prompt\(\{[\s\S]*?sessionId,[\s\S]*?content,/);
  assert.match(sendPrompt, /latestTurnResults: withoutRecordKey/);
  assert.doesNotMatch(sendPrompt, /truncateFromMessageId/);
  assert.match(styles, /\.turn-outcome-card\s*\{/);
  assert.match(styles, /\.turn-outcome-card\.failed\s*\{/);
});
