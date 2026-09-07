import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [apiSource, appSource, composerSource, settingsSource, commandsSource, storeSource, surfaceSource, transcriptSource, barSource, topbarSource, componentSpec, englishSource, chineseSource, planStateSource] =
  await Promise.all([
    read("../src/lib/api.ts"),
    read("../src/App.tsx"),
    read("../src/components/Composer.tsx"),
    read("../src/pages/SettingsPage.tsx"),
    read("../src/lib/commands.ts"),
    read("../src/stores/app-store.ts"),
    read("../src/components/ChatSurface.tsx"),
    read("../src/components/ChatTranscript.tsx"),
    read("../src/components/PlanApprovalBar.tsx"),
    read("../src/components/ConversationTopbar.tsx"),
    read("../../../docs/spec/04-ux/08-component-spec.md"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../src/lib/plan-mode-state.ts"),
  ]);
const legacyModeKey = ["mode", "Chat"].join("");
const legacyModeCommand = ["builtin.mode", "chat"].join(".");
const legacyModeLiteral = ["mode:", '"chat"'].join(" ");

test("renderer exposes Agent, Plan, and Goal as the only operating modes", () => {
  assert.match(composerSource, /MODE_CYCLE: readonly Mode\[\] = \["agent", "plan", "goal"\]/);
  assert.match(composerSource, /settings\.modePlan/);
  assert.match(composerSource, /settings\.modeGoal/);
  assert.match(composerSource, /IconListChecks/);
  assert.match(composerSource, /IconTarget/);
  assert.match(settingsSource, /\["plan", "settings\.modePlan"\]/);
  assert.match(settingsSource, /\["goal", "settings\.modeGoal"\]/);
  assert.match(commandsSource, /case "builtin\.mode\.plan"/);
  assert.match(commandsSource, /case "builtin\.mode\.goal"/);
  for (const source of [composerSource, settingsSource, commandsSource]) {
    assert.doesNotMatch(source, new RegExp(`${legacyModeKey}|${legacyModeCommand}|${legacyModeLiteral}`));
  }
});

test("plan IPC and host events are typed and restored across renderer entry points", () => {
  assert.match(apiSource, /IPC\.invoke\.plansPending/);
  assert.match(apiSource, /IPC\.invoke\.plansResolve/);
  assert.match(apiSource, /IPC\.event\.plansChanged/);
  assert.match(appSource, /api\.onPlansChanged\(handlePlansChanged\)/);
  assert.match(storeSource, /restorePendingPlan: async/);
  assert.match(storeSource, /api\.pendingPlans\(\)/);
  assert.match(storeSource, /void get\(\)\.restorePendingPlan\(id\)/);
  assert.match(storeSource, /handlePlansChanged: \(event\)/);
  assert.match(storeSource, /event\.type === "planning_state"/);
});

test("only pending proposals form the renderer approval gate", () => {
  assert.match(storeSource, /latestPlanProposal\(\s*pendingPlansResult\.plans/);
  assert.match(storeSource, /pendingPlansResult\.plans\.filter\(isPendingPlan\)/);
  assert.match(
    storeSource,
    /nextState === "awaiting_approval" && isPendingPlan\(checkpoint\)/,
  );
  assert.match(
    storeSource,
    /pendingPlans: activeProposal[\s\S]*withoutRecordKey\(state\.pendingPlans, sessionId\)/,
  );
  assert.match(storeSource, /planCheckpoints: latestPlanCheckpoints/);
  assert.match(composerSource, /planCheckpoint\?\.status === "pending"/);
  assert.doesNotMatch(surfaceSource, /planCheckpoint\?\.status === "pending"/);
  assert.match(transcriptSource, /pendingPlans\[sessionId\]\?\.status === "pending"/);
  assert.match(composerSource, /planCheckpoint\?\.status === "pending"/);
  assert.match(composerSource, /disabled=\{controlsBlocked\}/);
  assert.doesNotMatch(topbarSource, /ModelSelect|model-chip/);
  assert.doesNotMatch(topbarSource, /ct-mode|configureActiveSession/);
});

test("reject or interruption returns editable planning without changing durable mode from runtime events", () => {
  const planEventBlock =
    storeSource.match(/if \(event\.type === "planning_state"\)[\s\S]*?\n    \}\n    \/\/ Any session/)?.[0] ?? "";
  assert.match(planEventBlock, /planningStates:/);
  assert.match(planEventBlock, /planCheckpoints:/);
  assert.match(planEventBlock, /nextPlanSyncGeneration\(envelope\.sessionId\)/);
  assert.match(planEventBlock, /restorePendingPlan\(envelope\.sessionId\)/);
  assert.match(planEventBlock, /pendingPlans:/);
  assert.doesNotMatch(planEventBlock, /sessions:/);
  const hostPlanEventBlock =
    storeSource.match(/handlePlansChanged: \(event\) =>[\s\S]*?\n  handleAgentEvent:/)?.[0] ?? "";
  assert.match(hostPlanEventBlock, /sessionModeForPlanningState\(\s*event\.state,/);
  // The contract kind, not the projected state, decides which mode is shown.
  assert.match(hostPlanEventBlock, /event\.kind \?\? checkpoint\?\.kind/);
  assert.match(hostPlanEventBlock, /planExecutionWasActive/);
  assert.match(storeSource, /get\(\)\.pendingPlans\[sessionId\]\?\.status === "pending"/);
  assert.match(storeSource, /get\(\)\.pendingPlans\[sessionId\]\?\.status === "pending"\) return;/);
  const sendPromptBlock =
    storeSource.match(/sendPrompt: async \(content, draft, requestedSessionId\)[\s\S]*?\n  compactContext:/)?.[0] ?? "";
  assert.match(sendPromptBlock, /get\(\)\.pendingPlans\[sessionId\]\?\.status === "pending"/);
  assert.match(sendPromptBlock, /await api\.prompt\(\{/);
  assert.match(sendPromptBlock, /sessionId,\s*content,/);
  assert.match(
    sendPromptBlock,
    /attachments: draft[\s\S]*promptAttachmentsFromDraft\(draft\.fileReferences\)/,
  );
});

test("host ordering uses a fresh monotonic token-checked read", () => {
  assert.doesNotMatch(storeSource, /pendingPlanLoads|pendingPlanLoadGenerations|pendingPlanFollowUps/);
  const restoreBlock =
    storeSource.match(/restorePendingPlan: async \(sessionId\)[\s\S]*?\n  \},\n\n  prefetchSession:/)?.[0] ?? "";
  assert.match(restoreBlock, /const generation = nextPlanSyncGeneration\(sessionId\)/);
  assert.match(restoreBlock, /await api\.pendingPlans\(sessionId\)/);
  assert.match(restoreBlock, /if \(generation !== planSyncGeneration\(sessionId\)\) return "unavailable"/);
  assert.match(restoreBlock, /return activeProposal \? "pending" : "terminal"/);
  const hostBlock =
    storeSource.match(/handlePlansChanged: \(event\) =>[\s\S]*?\n  handleAgentEvent:/)?.[0] ?? "";
  assert.match(hostBlock, /nextPlanSyncGeneration\(event\.sessionId\)/);
  assert.match(hostBlock, /withoutRecordKey\(state\.pendingPlans, event\.sessionId\)/);
});

test("the component spec assigns mode ownership to Composer", () => {
  const topbarSpec = componentSpec.slice(
    componentSpec.indexOf("## 2. Topbar"),
    componentSpec.indexOf("## 3. Sidebar"),
  );
  const composerSpec = componentSpec.slice(
    componentSpec.indexOf("## 11. Composer"),
    componentSpec.indexOf("## 12.", componentSpec.indexOf("## 11. Composer")),
  );
  assert.match(topbarSpec, /Project\s+scope/);
  assert.doesNotMatch(topbarSpec, /model picker/);
  assert.doesNotMatch(topbarSpec, /Agent \| Plan|mode toggle|mode indicator/);
  assert.match(composerSpec, /combined model ×\s+reasoning-level control/);
  assert.match(composerSpec, /Composer-left Agent\/Plan\/Goal chip is the sole mode/);
});

test("plan approval sends exact identities and waits for host confirmation", () => {
  assert.match(barSource, /proposalId: proposal\.id/);
  assert.match(barSource, /sessionId: proposal\.sessionId/);
  assert.match(barSource, /turnId: proposal\.turnId/);
  assert.match(barSource, /toolCallId: proposal\.toolCallId/);
  assert.match(barSource, /version: proposal\.version/);
  assert.match(
    barSource,
    /action === "approve"\s*\?\s*\{[\s\S]*targetPermissionMode:[\s\S]*\}\s*:\s*\{[\s\S]*\.\.\.identity,\s*action\s*\}/,
  );
  assert.doesNotMatch(barSource, /request_changes/);
  assert.match(barSource, /data-testid="plan-approval-bar"/);
  assert.match(barSource, /role="menuitemradio"/);
  assert.match(barSource, /aria-checked=\{approvalMode === candidate\}/);
  assert.match(barSource, /PLAN_APPROVAL_DEFAULT_MODE/);
  assert.doesNotMatch(barSource, /planApprovalPermissionMode|feedback|changes_requested/);
  assert.match(barSource, /ArrowDown.*ArrowUp.*Home.*End/s);
  assert.match(transcriptSource, /const approvalPending = useAppStore/);
  assert.match(transcriptSource, /pendingPlans\[sessionId\]\?\.status === "pending"/);
  assert.doesNotMatch(transcriptSource, /PlanApprovalCard|plan-approval-card/);
  assert.doesNotMatch(transcriptSource, /\bpendingPlan\b/);
  assert.match(storeSource, /openPlanArtifact/);
  assert.match(storeSource, /fileWorkPanelTab\(relativePath\)/);
  assert.match(barSource, /const isPending = proposal\.status === "pending"/);
  const resolveBlock = storeSource.match(/resolvePlan: async \(resolution\)[\s\S]*?\n  showToast:/)?.[0] ?? "";
  assert.match(resolveBlock, /await api\.resolvePlan\(resolution\)/);
  assert.match(resolveBlock, /get\(\)\.handlePlansChanged/);
  assert.doesNotMatch(resolveBlock, /planApprovalPermissionMode/);
  assert.doesNotMatch(storeSource, /planApprovalPermissionMode/);
  assert.doesNotMatch(resolveBlock, /finally[\s\S]*pendingPlans/);
});

test("terminal Plan checkpoints stop rendering the approval bar", () => {
  for (const status of ["rejected", "expired", "interrupted", "approved", "queued", "running"]) {
    assert.match(planStateSource, new RegExp(`"${status}"`));
  }
  assert.doesNotMatch(barSource, /planCheckpointStatus|plan-approval-status|plan-approval-expiry/);
  assert.match(
    composerSource,
    /planCheckpoint\?\.status === "pending"[\s\S]*<PlanApprovalBar proposal=\{planCheckpoint\} \/>/,
  );
  assert.doesNotMatch(barSource, /feedback|changes_requested|request_changes|requestChanges/);
});

test("mode commands configure the active session instead of only changing defaults", () => {
  const modeCommandBlock =
    commandsSource.match(/case "builtin\.mode\.agent"[\s\S]*?\n    }/)?.[0] ?? "";
  assert.match(modeCommandBlock, /activeSession/);
  assert.match(modeCommandBlock, /await store\.configureActiveSession\(/);
  assert.match(modeCommandBlock, /thinkingLevel: activeSession\.thinkingLevel/);
  assert.match(modeCommandBlock, /else if \(store\.settings\)/);
});

test("pending approval keeps the draft while gating every composer control", () => {
  assert.match(composerSource, /contentEditable=\{!inputBlocked\}/);
  assert.match(composerSource, /aria-readonly=\{inputBlocked\}/);
  assert.match(composerSource, /enabled: !inputBlocked/);
  assert.match(composerSource, /disabled=\{controlsBlocked\}/);
  assert.match(composerSource, /const controlsBlocked = approvalPending;/);
  assert.match(composerSource, /const sendBlocked = approvalPending \|\| pasting;/);
  assert.match(storeSource, /if \(get\(\)\.pendingPlans\[sessionId\]\?\.status === "pending"\) return/);
});

test("composer configuration is retained on the draft when no session is active", () => {
  assert.match(
    storeSource,
    /const sessionId = get\(\)\.activeSessionId;[\s\S]*?if \(!sessionId\) \{[\s\S]*?draftConfiguration: \{[\s\S]*?mode: config\.mode,[\s\S]*?thinkingLevel: config\.thinkingLevel,/,
  );
  assert.match(composerSource, /disabled=\{controlsBlocked\}/);
});

test("Plan approval labels and remembered modes are locale-backed", () => {
  assert.match(englishSource, /modePlan: "Plan"/);
  assert.match(chineseSource, /modePlan: "规划"/);
  assert.match(englishSource, /modeGoal: "Goal"/);
  assert.match(chineseSource, /modeGoal: "目标"/);
  assert.match(englishSource, /approvalRegion: "Plan approval"/);
  assert.match(chineseSource, /approvalRegion: "规划审批"/);
  assert.match(englishSource, /approvalRegion: "Goal approval"/);
  assert.match(chineseSource, /approvalRegion: "目标审批"/);
  assert.match(englishSource, /statusQueued: "Plan queued"/);
  assert.match(chineseSource, /statusQueued: "规划已排队"/);
  assert.match(englishSource, /statusQueued: "Goal queued"/);
  assert.match(chineseSource, /statusQueued: "目标已排队"/);
  assert.match(englishSource, /approveAuto: "Approve \(Auto\)"/);
  assert.match(chineseSource, /approveAuto: "批准（全自动）"/);
  assert.doesNotMatch(englishSource, /expiresAt:/);
  assert.doesNotMatch(chineseSource, /expiresAt:/);
  assert.match(englishSource, /autoWarning: "Auto runs Bash without asking and may change files\."/);
  assert.match(chineseSource, /autoWarning: "自动模式会直接运行 Bash，且可能修改文件。"/);
  assert.doesNotMatch(englishSource, new RegExp(legacyModeKey));
  assert.doesNotMatch(chineseSource, new RegExp(legacyModeKey));
});
