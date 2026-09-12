import { readAppSource, readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(
  new URL("../src/components/workpanel/SubagentPanel.tsx", import.meta.url),
  "utf8",
);
const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const transcriptSource = await readTranscriptSource();
const detailSource = transcriptSource.slice(
  transcriptSource.indexOf("export function SubagentDetail"),
  transcriptSource.indexOf("/**\n * A truthful one-level graph", transcriptSource.indexOf("export function SubagentDetail")),
);
const failureCardSource = transcriptSource.slice(
  transcriptSource.indexOf("function SubagentFailureCard("),
  transcriptSource.indexOf("export function SubagentDetail"),
);
const storeSource = await readStoreSource();
const workPanelCss = await readFile(
  new URL("../src/styles/work-panel.css", import.meta.url),
  "utf8",
);
const messagesCss = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);


test("a topology node toggles a session-scoped side-panel selection", () => {
  assert.match(transcriptSource, /const toggleSubagentPanel = useAppStore\(\(s\) => s\.toggleSubagentPanel\)/);
  assert.match(transcriptSource, /const panelSelectionId =/);
  assert.match(transcriptSource, /toggleSubagentPanel\(panelSelectionId\)/);
  assert.match(transcriptSource, /aria-controls=\{hasDetails \? "subagent-panel" : undefined\}/);
  assert.match(transcriptSource, /variant !== "topology" && open/);
  assert.match(transcriptSource, /variant !== "topology" && open && hasDetails/);
  assert.match(storeSource, /subagentPanel: SubagentPanelSelection \| null/);
  assert.match(storeSource, /toggleSubagentPanel:\s*\(delegationId\) => \{/);
  assert.match(
    storeSource,
    /state\.subagentPanel\?\.sessionId === sessionId[\s\S]*?state\.subagentPanel\.delegationId === id[\s\S]*?set\(\{ subagentPanel: null \}\)/,
  );
  assert.match(storeSource, /set\(\{ subagentPanel: \{ sessionId, delegationId: id \} \}\)/);
  assert.match(storeSource, /closeSubagentPanel: \(\) => set\(\{ subagentPanel: null \}\)/);
  assert.match(storeSource, /if \(state\.subagentPanel\) \{/);
  assert.match(storeSource, /state\.closeSubagentPanel\(\)/);
  assert.match(storeSource, /if \(get\(\)\.workPanelOpen\) get\(\)\.collapseWorkPanel\(\)/);
});

test("the side panel renders the live conversation process", () => {
  assert.match(panelSource, /<SubagentDetail/);
  assert.match(panelSource, /data-testid="subagent-panel"/);
  assert.match(panelSource, /selected\.item\.delegate/);
  assert.doesNotMatch(panelSource, /role="tablist"|aria-selected|subagent-panel-tabs/);
  assert.match(transcriptSource, /function delegateTaskDescription\(message: UiMessage\)/);
  assert.match(detailSource, /className="subagent-detail-hero"/);
  assert.match(detailSource, /className="subagent-detail-task-card"/);
  assert.match(detailSource, /panel.subagentTask/);
  assert.match(detailSource, /subagentTaskExpand/);
  assert.match(detailSource, /subagentTaskCollapse/);
  assert.match(detailSource, /aria-controls={taskBodyId}/);
  assert.match(workPanelCss, /-webkit-line-clamp: 4/);
  assert.match(detailSource, /<SubagentRunRows/);
  assert.match(detailSource, /scrollable=\{false\}/);
  assert.match(detailSource, /variant="dock"/);
});

test("the side panel re-finds live rows instead of storing a stale render snapshot", () => {
  assert.match(panelSource, /buildTranscriptEntries\(messages\)/);
  assert.match(panelSource, /selection\.delegationId/);
  assert.match(panelSource, /retainedTranscripts\[selection\.sessionId\]/);
  assert.match(panelSource, /collectDelegationStatuses\(selected\.turnActivityItems/);
  assert.match(panelSource, /collectDelegationTimings\(selected\.turnActivityItems\)/);
  assert.match(panelSource, /<SubagentDetail/);
  assert.match(panelSource, /data-testid="subagent-panel"/);
  assert.match(panelSource, /selected\.item\.message/);
});

test("the work-panel dock hosts subagent details without creating a resource tab", () => {
  assert.match(workPanelSource, /subagentPanel\?: SubagentPanelSelection \| null/);
  assert.match(workPanelSource, /onCloseSubagentPanel\?: \(\) => void/);
  assert.match(workPanelSource, /\{subagentPanel \? \(/);
  assert.match(workPanelSource, /<SubagentPanel selection=\{subagentPanel\} \/>/);
  assert.match(workPanelSource, /!subagentPanel && activeTab\?\.kind === "review"/);
  assert.match(workPanelSource, /subagentPanel && onCloseSubagentPanel/);
  assert.match(appSource, /const subagentPanelOpen = Boolean\(/);
  assert.match(appSource, /page === "chat"/);
  assert.match(appSource, /page !== "chat" \|\| subagentPanel\.sessionId !== activeSessionId/);
  assert.match(appSource, /workPanelOpen \|\| subagentPanelOpen/);
  assert.match(appSource, /subagentPanel=\{subagentPanelOpen \? subagentPanel : null\}/);
  assert.doesNotMatch(workPanelSource, /setContextOpen/);
});

test("the task dock keeps one body scroll owner while the process streams", () => {
  assert.match(workPanelCss, /\.subagent-panel \{[^}]*flex: 1/);
  assert.match(workPanelCss, /\.subagent-panel-scroll \{[^}]*overflow-y: auto/);
  assert.match(messagesCss, /\.subagent-run-rows\.is-panel-flow \{[\s\S]*?overflow: visible/);
  assert.match(panelSource, /useFollowScroll\(\)/);
  assert.match(panelSource, /ref=\{scrollRef\}/);
  assert.match(panelSource, /onScroll=\{handleScroll\}/);
  assert.match(panelSource, /onClick=\{jumpToLatest\}/);
  assert.match(panelSource, /role="log"/);
  assert.match(panelSource, /aria-live="polite"/);
  assert.match(panelSource, /tabIndex=\{0\}/);
  assert.match(panelSource, /\[jumpToLatest, selection\.delegationId\]/);
});

test("the subagent dock uses a grouped identity, task card, and process timeline", () => {
  assert.match(
    detailSource,
    /className="subagent-detail-hero"[\s\S]*?subagent-detail-badge[\s\S]*?subagent-detail-meta/,
  );
  assert.match(
    workPanelCss,
    /\.subagent-detail-hero\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;[\s\S]*?flex-direction:\s*row;/,
  );
  assert.match(
    workPanelCss,
    /\.subagent-detail-summary\s*\{[\s\S]*?flex-wrap:\s*nowrap;/,
  );
  assert.match(
    detailSource,
    /className="subagent-detail-task"[\s\S]*?className="subagent-detail-task-card"/,
  );
  assert.match(
    workPanelCss,
    /\.subagent-detail-task-card\s*\{[\s\S]*?border-radius:\s*var\(--radius-md\);[\s\S]*?background:\s*var\(--ds-tile\);/,
  );
  assert.match(
    workPanelCss,
    /\.subagent-detail-badge\s*\{[\s\S]*?border-radius:\s*var\(--radius-full\);/,
  );
  assert.match(
    workPanelCss,
    /\.subagent-detail > \.subagent-run\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?padding:\s*0 16px;/,
  );
  assert.match(messagesCss, /\.subagent-run\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(messagesCss, /\.subagent-run-follow\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(
    workPanelCss,
    /\.subagent-detail > \.subagent-run \.subagent-run-rows\s*\{[\s\S]*?border-left:\s*1px solid var\(--ds-border-subtle\);[\s\S]*?background:\s*transparent;/,
  );
  assert.match(transcriptSource, /t\("chat.subagentProcess"\)/);
  assert.match(detailSource, /variant="dock"/);
});

test("a settled delegate that failed explains itself at the foot of the dock", () => {
  // The status says *that* a delegate failed; only the lifecycle rows can say
  // why (ADR 0089), and the dock is the surface that renders the outcome.
  assert.match(panelSource, /collectDelegationFailures\(selected\.turnActivityItems\)/);
  assert.match(panelSource, /delegationFailures=\{delegationFailures\}/);
  assert.match(
    detailSource,
    /delegationFailures\?: ReadonlyMap<string, DelegationFailure>/,
  );
  assert.match(detailSource, /delegationFailures\?\.get\(delegationId\)/);
  // Tied to a non-success terminal outcome, not to the error field alone, so a
  // completed or still-running delegate never shows an error card.
  assert.match(
    detailSource,
    /failure && outcome !== "completed" && outcome !== "running"/,
  );
  assert.match(failureCardSource, /function SubagentFailureCard\(/);
  assert.match(failureCardSource, /data-testid="subagent-failure"/);
  assert.match(failureCardSource, /className="message-error subagent-failure"/);
  assert.match(failureCardSource, /t\(`chat\.subagentStatus\.\$\{outcome\}`\)/);
  assert.match(failureCardSource, /t\(localizedKey\)/);
  assert.match(failureCardSource, /<CopyButton /);
  // The disclosure control must precede the region it collapses, otherwise
  // hiding the details would take away the control that brings them back.
  assert.match(
    failureCardSource,
    /className="message-error-toggle"[\s\S]*?className=\{`message-error-details/,
  );
  assert.match(
    workPanelCss,
    /\.subagent-detail > \.subagent-failure\s*\{[\s\S]*?margin:\s*0 16px;/,
  );
});
