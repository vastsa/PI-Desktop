import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [store, transcript, messagesStyles, proseStyles, en, zh] =
  await Promise.all([
    read("../src/stores/app-store.ts"),
    read("../src/components/ChatTranscript.tsx"),
    read("../src/styles/messages.css"),
    read("../src/styles/prose.css"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  ]);

test("active turns show immediate feedback without a progress card", () => {
  assert.match(transcript, /function WorkingIndicator\(\)/);
  assert.match(transcript, /data-testid="working-indicator"/);
  assert.match(transcript, /role="status"/);
  assert.match(transcript, /className="working-indicator-mark" aria-hidden="true"/);
  assert.match(transcript, /className="working-indicator-label"/);
  assert.match(transcript, /const showWorking =/);
  assert.match(transcript, /\{showWorking \? <WorkingIndicator \/> : null\}/);
  assert.doesNotMatch(transcript, /AgentProgressTimeline|agent-progress/);
  assert.match(transcript, /<PermissionCard/);
  assert.doesNotMatch(store, /AgentProgress|agentProgress|updateAgentProgress/);
  assert.match(messagesStyles, /\.working-indicator\s*\{/);
  assert.match(messagesStyles, /\.working-indicator-mark\s*\{/);
  assert.match(messagesStyles, /\.working-indicator-mark > span\s*\{[\s\S]*?animation:\s*working-indicator-dot\s+1s/);
  assert.doesNotMatch(proseStyles, /\.working-indicator\s*\{|\.shimmer-text\s*\{/);
  assert.doesNotMatch(messagesStyles, /\.shimmer-text\s*\{|animation:\s*shimmer\b/);
  assert.match(
    messagesStyles,
    /\.tool-activity-label\.running::after,\s*\.tool-row-name\.running::after\s*\{[\s\S]*?animation:\s*activity-marker-pulse\s+1s/,
  );
  assert.doesNotMatch(
    en,
    /progressUnderstanding|progressWorking|progressChecking|progressFinalizing|progressWaiting/,
  );
  assert.doesNotMatch(
    zh,
    /progressUnderstanding|progressWorking|progressChecking|progressFinalizing|progressWaiting/,
  );
});
