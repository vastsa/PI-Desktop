import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const readDesktop = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
const readPackage = (relativePath) =>
  readFile(new URL(`../../../packages/i18n/${relativePath}`, import.meta.url), "utf8");

const [approvalBar, approvalPreferences, apiSource, storeSource, settingsPage, settingsSearch, styles, english, chinese, planStateSource, composerSource] =
  await Promise.all([
    readDesktop("src/components/PlanApprovalBar.tsx"),
    readDesktop("src/lib/plan-approval-preferences.ts"),
    readDesktop("src/lib/api.ts"),
    readDesktop("src/stores/app-store.ts"),
    readDesktop("src/pages/SettingsPage.tsx"),
    readDesktop("src/lib/settings-search.ts"),
    loadStyles(),
    readPackage("src/locales/en/index.ts"),
    readPackage("src/locales/zh-CN/index.ts"),
    readDesktop("src/lib/plan-mode-state.ts"),
    readDesktop("src/components/Composer.tsx"),
  ]);

test("plan approval exposes only the artifact and remembers the selected mode", () => {
  assert.match(approvalBar, /proposal\.title/);
  assert.match(approvalBar, /fileWorkPanelTab\(artifactPath\)/);
  assert.match(approvalBar, /openWorkPanelTabForSession/);
  assert.match(approvalBar, /const isPending = proposal\.status === "pending"/);
  assert.match(approvalBar, /PLAN_APPROVAL_DEFAULT_MODE/);
  assert.match(approvalBar, /readPlanApprovalMode\(\)/);
  assert.match(approvalBar, /rememberPlanApprovalMode\(selectedMode\)/);
  assert.match(approvalPreferences, /PLAN_APPROVAL_MODE_STORAGE_KEY/);
  assert.match(approvalPreferences, /store\.setItem\(PLAN_APPROVAL_MODE_STORAGE_KEY, mode\)/);
  assert.match(approvalPreferences, /PLAN_APPROVAL_FALLBACK_MODE/);
  assert.doesNotMatch(approvalBar, /proposal\.question|proposal\.expiresAt|autoWarning|expiresAt|statusText/);
  assert.doesNotMatch(approvalBar, /planApprovalPermissionMode|feedback|changes_requested/);
  assert.doesNotMatch(apiSource, /planApprovalPermissionMode/);
  assert.doesNotMatch(storeSource, /planApprovalPermissionMode/);
  // Every label resolves under the proposal kind's namespace, so one bar serves
  // both `plan.*` and `goal.*` copy (D198).
  assert.match(approvalBar, /return `\$\{kind\}\.\$\{name\}`/);
  assert.match(approvalBar, /const copy = \(name: string\) => t\(copyKey\(kind, name\)\)/);
  assert.doesNotMatch(approvalBar, /t\("plan\./);
  assert.match(approvalBar, /data-testid="plan-open-artifact"/);
  assert.doesNotMatch(approvalBar, /request_changes|requestChanges/);
});

test("approval card omits validity details while the pending gate stays actionable", () => {
  assert.doesNotMatch(approvalBar, /PLAN_APPROVAL_RECONCILE_RETRY_MS|window\.setTimeout|restorePendingPlan/);
  assert.doesNotMatch(approvalBar, /plan-approval-question|plan-approval-expiry|plan-approval-status|plan-approval-warning/);
  assert.match(approvalBar, /className="plan-approval-title"/);
  assert.match(approvalBar, /className="plan-approval-artifact"/);
  assert.match(approvalBar, /disabled=\{busy\}/);
  assert.match(
    storeSource,
    /PendingPlanRefreshResult = "pending" \| "terminal" \| "unavailable"/,
  );
  assert.match(
    storeSource,
    /const generation = nextPlanSyncGeneration\(sessionId\)/,
  );
  assert.match(storeSource, /await api\.pendingPlans\(sessionId\)/);
  assert.match(
    storeSource,
    /if \(generation !== planSyncGeneration\(sessionId\)\) return "unavailable"/,
  );
  assert.doesNotMatch(storeSource, /pendingPlanLoads|pendingPlanLoadGenerations|pendingPlanFollowUps/);
  const resolveBlock =
    storeSource.match(/resolvePlan: async \(resolution\)[\s\S]*?\n  showToast:/)?.[0] ?? "";
  assert.match(resolveBlock, /ErrorCodes\.PLAN_APPROVAL_TIMEOUT/);
  assert.match(
    resolveBlock,
    /await get\(\)\.restorePendingPlan\(resolution\.sessionId\)/,
  );
  assert.match(
    storeSource,
    /return activeProposal \? "pending" : "terminal"/,
  );
  assert.match(storeSource, /isPendingPlan\(checkpoint\)/);
  assert.match(storeSource, /pendingPlans\[sessionId\]\?\.status === "pending"/);
  assert.match(storeSource, /pendingPlans\[resolution\.sessionId\]/);
  assert.match(storeSource, /planCheckpoints: checkpoint/);
});

test("terminal execution snapshots are represented and do not gate a later prompt", () => {
  assert.match(planStateSource, /executionState === "queued"/);
  assert.match(planStateSource, /executionState === "running"/);
  assert.match(planStateSource, /executionState === "completed"/);
  assert.match(planStateSource, /status === "rejected"/);
  assert.match(planStateSource, /status === "expired"/);
  assert.match(planStateSource, /return "interrupted"/);
  assert.match(composerSource, /const runActive = isRunning \|\| executionActive/);
  assert.match(composerSource, /const sendBlocked = approvalPending \|\| pasting/);
  assert.match(composerSource, /planCheckpoint\?\.status === "pending"[\s\S]*<PlanApprovalBar/);
  assert.doesNotMatch(approvalBar, /request_changes|requestChanges/);
});

test("command-shell settings are catalog-driven and use the existing save flow", () => {
  assert.match(settingsPage, /api\s*\.\s*listCommandShells\(\)/s);
  assert.match(settingsPage, /settings\.defaultCommandShell/);
  assert.match(settingsPage, /catalog\.choices\.map/);
  assert.match(settingsPage, /disabled=\{!choice\.available\}/);
  assert.match(settingsPage, /saveSettings\(\{ defaultCommandShell: choice\.id \}\)/);
  assert.match(settingsPage, /catalog\.configuredId/);
  assert.match(settingsPage, /catalog\??\.effective/);
  assert.match(settingsSearch, /"settings\.commandShell"/);
});

test("approval and shell surfaces have locale-backed responsive copy", () => {
  for (const source of [english, chinese]) {
    assert.match(source, /openArtifact:/);
    assert.match(source, /commandShell:/);
    assert.match(source, /commandShellUnavailable:/);
  }
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(styles, /container-name: composer-stack/);
  assert.doesNotMatch(styles, /\.plan-approval-warning|\.plan-approval-expiry|\.plan-approval-status/);
  assert.match(styles, /@media \(max-width: 820px\)\s*\{[\s\S]*\.settings-row/);
});
