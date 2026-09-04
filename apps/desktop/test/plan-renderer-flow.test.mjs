import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readDesktop = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

const [store, planState, approvalBar, composer, packageJson] =
  await Promise.all([
    readDesktop("src/stores/app-store.ts"),
    readDesktop("src/lib/plan-mode-state.ts"),
    readDesktop("src/components/PlanApprovalBar.tsx"),
    readDesktop("src/components/Composer.tsx"),
    readDesktop("package.json"),
  ]);

test("rejection clears only the live gate and a later proposal replaces the checkpoint", () => {
  const hostPlanBlock =
    store.match(/handlePlansChanged: \(event\) =>[\s\S]*?\n  handleAgentEvent:/)?.[0] ?? "";
  assert.match(hostPlanBlock, /mergePlanCheckpoint/);
  assert.match(hostPlanBlock, /planCheckpoints: checkpoint/);
  assert.match(hostPlanBlock, /const pendingPlans = activeProposal/);
  assert.match(hostPlanBlock, /\n\s+pendingPlans,/);
  assert.match(hostPlanBlock, /withoutRecordKey\(state\.pendingPlans, event\.sessionId\)/);
  assert.match(planState, /if \(event\.proposal\) return event\.proposal/);
  assert.match(planState, /current\.status === "pending" && event\.state === "planning"/);
});

test("terminal proposals and execution states stay session-scoped and readable", () => {
  for (const status of ["rejected", "expired", "interrupted", "approved", "queued", "running"]) {
    assert.match(planState, new RegExp(`"${status}"`));
  }
  assert.match(store, /planCheckpoints: Record<string, PlanProposal>/);
  assert.match(composer, /planCheckpoint\?\.status === "pending"[\s\S]*<PlanApprovalBar proposal=\{planCheckpoint\} \/>/);
  assert.match(approvalBar, /data-execution-state=\{proposal\.executionState \|\| ""\}/);
  assert.doesNotMatch(approvalBar, /changes_requested|request_changes|requestChanges|feedback/);
  assert.doesNotMatch(store, /planApprovalPermissionMode/);
});

test("each pending proposal restores the remembered approval choice", () => {
  assert.match(approvalBar, /useState<GlobalPermissionMode>\(\s*readPlanApprovalMode\(\)/);
  assert.match(approvalBar, /setApprovalMode\(readPlanApprovalMode\(\)\)/);
  assert.match(approvalBar, /rememberPlanApprovalMode\(selectedMode\)/);
  assert.match(approvalBar, /\}, \[proposal\.id\]\);/);
  assert.doesNotMatch(approvalBar, /state\.settings|planApprovalPermissionMode/);
});

test("pending input is retained but every composer/model mutation control is gated", () => {
  assert.match(composer, /contentEditable=\{!inputBlocked\}/);
  assert.match(composer, /aria-readonly=\{inputBlocked\}/);
  assert.match(composer, /enabled: !inputBlocked/);
  assert.match(composer, /disabled=\{controlsBlocked\}/);
  assert.match(composer, /const controlsBlocked = approvalPending;/);
  assert.match(composer, /const sendBlocked = approvalPending \|\| pasting;/);
  assert.match(store, /pendingPlans\[sessionId\]\?\.status === "pending"/);
  assert.match(store, /pendingPlans\[resolution\.sessionId\]/);
});

test("the normal desktop test command includes source-level renderer contracts", () => {
  const scripts = JSON.parse(packageJson).scripts;
  assert.match(scripts.test, /src\/\*\.test\.mjs/);
});
