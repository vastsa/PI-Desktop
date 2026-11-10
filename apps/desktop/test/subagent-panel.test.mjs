import { readAppSource, readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isKnownWorkPanelTab } from "../src/lib/work-panel-tabs.ts";

const tabSource = await readFile(
  new URL("../src/components/workpanel/SubagentTranscriptTab.tsx", import.meta.url),
  "utf8",
);
const composerSource = await readFile(
  new URL("../src/features/subagents/SubagentMessageComposer.tsx", import.meta.url),
  "utf8",
);
const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const tabsSource = await readFile(
  new URL("../src/lib/work-panel-tabs.ts", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const transcriptSource = await readTranscriptSource();
const storeSource = await readStoreSource();
const workPanelCss = await readFile(
  new URL("../src/styles/work-panel.css", import.meta.url),
  "utf8",
);
const englishCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const chineseCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);


test("a topology node opens a real subagent tab in the work panel", () => {
  assert.match(transcriptSource, /const openSubagentTab = useAppStore\(\(s\) => s\.openSubagentTab\)/);
  assert.match(transcriptSource, /const panelSelectionId =/);
  assert.match(transcriptSource, /openSubagentTab\(panelSelectionId, agentName \|\| undefined\)/);
  assert.match(
    transcriptSource,
    /activeWorkPanelTabId === `subagent:\$\{panelSelectionId\}`/,
  );
  assert.match(
    transcriptSource,
    /aria-controls=\{panelOpen \? `work-panel-surface-subagent:\$\{panelSelectionId\}` : undefined\}/,
  );
  assert.match(storeSource, /openSubagentTab: \(delegationId, agentName\) => \{/);
  assert.match(
    storeSource,
    /openWorkPanelTab\(subagentWorkPanelTab\(id, agentName \|\| undefined\)\)/,
  );
  // The overlay state and its actions are gone: closing happens per tab.
  assert.doesNotMatch(storeSource, /subagentPanel/);
  assert.doesNotMatch(storeSource, /toggleSubagentPanel|closeSubagentPanel/);
  assert.match(tabsSource, /\|\s*"subagent"\s*(?:\||;)/);
  assert.match(
    tabsSource,
    /export function subagentWorkPanelTab\(\s*delegationId: string,\s*agentName\?: string,\s*\): WorkPanelTab \{/,
  );
  assert.match(tabsSource, /id: `subagent:\$\{delegationId\}`/);
  // Retained runtime state must survive the session-switch sanitizer.
  assert.equal(isKnownWorkPanelTab({ id: "subagent:fixture", kind: "subagent" }), true);
  assert.match(tabsSource, /export function subagentTabDisplayLabels\(/);
});

test("the work panel renders the delegation tab like every other resource", () => {
  assert.match(workPanelSource, /subagent: IconBot/);
  assert.match(workPanelSource, /if \(tab\.kind === "subagent"\) return tab\.label \?\? t\("panel\.tabs\.subagent"\);/);
  assert.match(workPanelSource, /const subagentTabsInOrder = tabs\.filter\(\(tab\) => tab\.kind === "subagent"\)/);
  assert.match(workPanelSource, /subagentTabDisplayLabels\(/);
  assert.match(workPanelSource, /\{activeTab\?\.kind === "subagent" && \(/);
  assert.match(
    workPanelSource,
    /<SubagentTranscriptTab delegationId=\{activeTab\.resource \?\? ""\} \/>/,
  );
  // The tab strip is never replaced by a dock heading or a back control.
  assert.doesNotMatch(workPanelSource, /work-panel-subagent-heading|work-panel-subagent-back/);
  assert.doesNotMatch(workPanelSource, /subagentPanel\?: SubagentPanelSelection/);
  assert.doesNotMatch(workPanelSource, /!subagentPanel &&/);
  // The shell no longer overrides visibility for a dock-only surface.
  assert.match(appSource, /const workPanelVisible = workPanelOpen;/);
  assert.doesNotMatch(appSource, /subagentPanelOpen/);
});

test("the delegation tab renders a message list with a session-scoped child composer", () => {
  assert.match(tabSource, /data-testid="subagent-transcript-tab"/);
  assert.match(tabSource, /buildSubagentTranscript\(messages, delegationId\)/);
  assert.match(tabSource, /className="message-row user"/);
  assert.match(tabSource, /className="message-user-text selectable"/);
  assert.match(tabSource, /className="message-row assistant"/);
  assert.match(tabSource, /data-message-id=\{row\.message\.id\}/);
  assert.match(tabSource, /<SubagentMessageComposer sessionId=\{activeSessionId \?\? ""\}/);
  assert.match(tabSource, /ready=\{ready && Boolean\(transcriptResult\) && !chain\?\.creating\}/);
  assert.match(composerSource, /const editable = control\.allowed && ready;/);
  assert.match(composerSource, /<Textarea disabled=\{!editable\}/);
  assert.match(composerSource, /rows=\{2\}/);
  assert.match(composerSource, /panel\.sessionSubagents\.control\.unavailable/);
  assert.match(composerSource, /className="subagent-transcript-composer-controls"/);
  assert.match(composerSource, /subagent-transcript-model-picker/);
  assert.match(composerSource, /<SubagentModelPicker/);
  assert.match(tabSource, /modelId=\{delegateSettings\.modelId\}/);
  assert.match(tabSource, /delegateModelId\(latestCall\)/);
  assert.match(tabSource, /delegateThinkingLevel\(latestCall\)/);
  assert.match(tabSource, /<SubagentStopButton delegationId=\{chain\?\.delegationId \?\? delegationId\}/);
  assert.doesNotMatch(tabSource, /subagent-transcript-actions/);
  assert.match(workPanelCss, /\.subagent-transcript-composer-controls \{/);
  assert.match(workPanelCss, /\.subagent-transcript-model-picker \{/);
  // Transcript rendering delegates commands to the permission-aware child composer.
  assert.doesNotMatch(tabSource, /onSubmit|onSend|api\.send/);
  assert.match(composerSource, /action: "message"/);
  assert.doesNotMatch(composerSource, /agentPrompt|api\.sendPrompt/);
});

test("the tab owns one scroll surface and pins to the latest output", () => {
  assert.match(workPanelCss, /\.subagent-transcript-tab \{[^}]*flex-direction: column/);
  assert.match(workPanelCss, /\.subagent-transcript-scroll \{[^}]*overflow-y: auto/);
  assert.match(tabSource, /useFollowScroll\(\)/);
  assert.match(tabSource, /ref=\{scrollRef\}/);
  assert.match(tabSource, /onScroll=\{handleScroll\}/);
  assert.match(tabSource, /onClick=\{jumpToLatest\}/);
  assert.match(tabSource, /role="log"/);
  assert.match(tabSource, /aria-live="polite"/);
  assert.match(tabSource, /tabIndex=\{0\}/);
  assert.match(tabSource, /useTranscriptSearchFocus\(\{/);
});

test("child-composer messages and unavailable states are localized", () => {
  for (const [locale, source] of [
    ["en", englishCatalogSource],
    ["zh-CN", chineseCatalogSource],
  ]) {
    assert.match(source, /messagePlaceholder: "/, locale);
    assert.match(source, /continuePlaceholder: "/, locale);
    assert.match(source, /tabs: \{[^}]*subagent: "/s, locale);
    assert.doesNotMatch(source, /subagentClose/, locale);
  }
});
