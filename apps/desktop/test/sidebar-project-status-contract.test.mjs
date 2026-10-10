import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  readMainModule,
  readMainSource,
  readSharedTypesSource,
  readStoreSource,
} from "./helpers/source-contracts.mjs";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

const sidebarSource = await read("src/components/Sidebar.tsx");
const shellRuntimeSource = await read("src/features/app/useAppShellRuntime.tsx");
const apiSource = await read("src/lib/api.ts");
const protocolSource = await read("../../packages/shared/src/protocol.ts");
const sharedTypes = await readSharedTypesSource();
const storeSource = await readStoreSource();
const mainSource = await readMainSource();
const scheduledRunnerSource = await readMainModule("runtime/scheduled-runner.ts");
const plansSource = await readMainModule("runtime/plans.ts");

test("a project row derives its status from state the renderer already holds", () => {
  const aggregateCall = sidebarSource.match(/projectRunningStatus\(\{[\s\S]*?\n {4}\}\);/)?.[0] ?? "";
  assert.match(aggregateCall, /sessions: entry\.sessions/);
  assert.match(aggregateCall, /allSessions: sessions/, "automation transcripts stay out of entry.sessions");
  assert.match(aggregateCall, /runningSessions,/);
  assert.match(aggregateCall, /outcomes: sessionOutcomes,/);
  assert.match(aggregateCall, /scheduledRuns: Object\.values\(scheduledRuns\)/);

  // Waiting for the reader covers every interactive prompt, not just permissions.
  const attentionBlock = sidebarSource.match(
    /const attentionSessionIds = useMemo\([\s\S]*?\n {2}\}, \[/,
  )?.[0] ?? "";
  assert.match(attentionBlock, /pendingPermissions/);
  assert.match(attentionBlock, /pendingAsks/);
  assert.match(attentionBlock, /pendingPlans/);
  assert.doesNotMatch(attentionBlock, /pendingApproval\w*\.length > 0 \? 1 : 0/);
});

test("a project row shows a light dot while running and a count once a result waits", () => {
  const renderBlock = sidebarSource.match(/const renderProjectGroup =[\s\S]*?\n {2}\};/)?.[0] ?? "";
  assert.match(renderBlock, /const collapsedProject = entry\.meta\.collapsed/);
  // The row reports; it does not add a target of its own (no button, no
  // data-action, nothing new for the header's click to yield to).
  assert.doesNotMatch(renderBlock, /data-action="project-status"/);
  assert.doesNotMatch(renderBlock, /statusTarget/);
  assert.match(
    renderBlock,
    /className=\{`project-status-dot \$\{status\.needsAttention > 0 \? "attention" : ""\}`\}/,
    "work in flight is the session rows' own dot, never a number",
  );
  const badge = renderBlock.match(
    /className=\{`project-status-badge \$\{status\.failed > 0 \? "failed" : ""\}`\}[\s\S]*?\{unreadResults\}/,
  )?.[0] ?? "";
  assert.ok(badge, "a count appears only for unread results");
  assert.match(renderBlock, /const unreadResults = status\.finished \+ status\.failed;/);
  // One mark at a time: the badge is the other branch of the same choice.
  assert.match(renderBlock, /\{status\.total > 0 \? \([\s\S]*?\) : unreadResults > 0 \? \(/);
  assert.doesNotMatch(renderBlock, /onClick=\{\(\) => \{\s*setCollapsed\(entry\.path, false\)/);
  // The mark is a child of the header's own title button, so the row's existing
  // hover hint is what explains it — one surface, not a second one.
  assert.ok(
    renderBlock.indexOf("project-status-dot") < renderBlock.indexOf("</TooltipButton>"),
    "the mark is hovered through the row's own hint",
  );
  assert.match(
    renderBlock,
    /tooltip=\{statusSummary \? `\$\{entry\.path\}\\n\$\{statusSummary\}` : entry\.path\}/,
  );
  assert.match(
    renderBlock,
    /tooltipClassName="ui-tooltip-path ui-tooltip-path-status"/,
    "the hint keeps the path and the sentence on their own lines",
  );
  assert.match(
    renderBlock,
    /\{statusSummary \? `\. \$\{t\("nav\.projectStatusLabel", \{ summary: statusSummary \}\)\}` : ""\}/,
    "assistive tech reads the same sentence without hovering",
  );
});

test("the renderer learns about a scheduled run from one additive broadcast", () => {
  assert.match(
    protocolSource,
    /scheduledChanged: "pi-desktop\/scheduled\/event\/changed"/,
  );
  assert.match(
    sharedTypes,
    /export type ScheduledRunChange = \{[\s\S]*?runId: string;[\s\S]*?sessionId: string;[\s\S]*?status: "running" \| "completed" \| "error";/,
  );
  assert.match(apiSource, /onScheduledChanged: \(listener: \(change: ScheduledRunChange\) => void\)/);
  assert.match(apiSource, /window\.piDesktop\.on\(IPC\.event\.scheduledChanged/);
  assert.match(
    apiSource,
    /const change = \(payload as \{ change\?: ScheduledRunChange \} \| null\)\?\.change;/,
  );
  assert.match(
    shellRuntimeSource,
    /const offScheduledChanged = api\.onScheduledChanged\(/,
  );
  assert.match(
    shellRuntimeSource.match(/offScheduledChanged\(\);/)?.[0] ?? "",
    /offScheduledChanged\(\);/,
    "the subscription is released on cleanup",
  );
});

test("a reload seeds the runs that started before it from the task list", () => {
  const seedBlock = shellRuntimeSource.match(
    /\/\/ A reload misses runs that started before it[\s\S]*?\n {4}\}\)\(\);/,
  )?.[0] ?? "";
  assert.match(seedBlock, /api\.listScheduled\(\)/);
  assert.match(seedBlock, /api\.listScheduledRuns\(\{ latestPerTask: true \}\)/);
  assert.match(
    seedBlock,
    /if \(run\.status !== "running" \|\| !run\.sessionId\) continue;/,
    "only a live run that owns a conversation can be attributed to a project",
  );
  assert.match(seedBlock, /sessionId: run\.sessionId,/);
  assert.match(seedBlock, /applyScheduledRunChanged\(\{/);
});

test("the store keeps the newest run state and ignores an incomplete event", () => {
  assert.match(
    storeSource,
    /applyScheduledRunChanged: \(change: ScheduledRunChange\) => \{\n\s+if \(!change\?\.runId \|\| !change\?\.sessionId\) return;/,
  );
  assert.match(storeSource, /scheduledRuns: \{\},\n {4}page: "chat"/);
});

test("main announces a run when it is admitted and when it settles", () => {
  assert.match(scheduledRunnerSource, /onChanged\?\.\(identity\);/, "admission is announced");
  assert.match(
    scheduledRunnerSource,
    /onChanged\?\.\(\{ \.\.\.identity, status: "error" \}\)/,
    "a dispatch failure settles the run it announced",
  );
  assert.match(scheduledRunnerSource, /const identity: ScheduledRunChange = \{[\s\S]*?status: "running",/);

  // Settlement is announced only after the durable end-of-run write succeeded.
  const finishBlock = plansSource.match(
    /if \(runId && runtimeState\.host\) \{[\s\S]*?status: reason === "completed" \? "completed" : "error",/,
  )?.[0] ?? "";
  assert.match(finishBlock, /await runtimeState\.host\n?\s*\.call\("scheduled\.finishRun"/);
  assert.match(finishBlock, /if \(settled\) \{/);
  assert.match(finishBlock, /sendToRenderer\(IPC\.event\.scheduledChanged/);

  assert.match(
    mainSource,
    /onRunChanged: \(change\) => sendToRenderer\(IPC\.event\.scheduledChanged, \{ change \}\)/,
  );
});

test("a newer run of one conversation replaces the tracked run", () => {
  const applyBlock = storeSource.match(
    /applyScheduledRunChanged: \(change: ScheduledRunChange\) => \{[\s\S]*?\n {4}\},/,
  )?.[0] ?? "";
  assert.match(
    applyBlock,
    /if \(run\.sessionId !== change\.sessionId\) scheduledRuns\[runId\] = run;/,
    "one conversation keeps one tracked run, so the map cannot grow per run",
  );
  assert.match(applyBlock, /scheduledRuns\[change\.runId\] = \{/);
});
