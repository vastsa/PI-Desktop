import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await build({ stdin: { resolveDir: root, contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { GoalStatusBar } from './apps/desktop/src/features/goals/GoalStatusBar';
import { GoalDetailsDialog } from './apps/desktop/src/features/goals/GoalDetailsDialog';
import { GoalResumeDialog } from './apps/desktop/src/features/goals/GoalResumeDialog';
import { autonomousGoalEn, autonomousGoalZhCN } from './packages/i18n/src/autonomous-goal';
export async function render(props, language='en', kind='bar') {
 await i18n.use(initReactI18next).init({lng:language,resources:{en:{translation:{autonomousGoal:autonomousGoalEn}},'zh-CN':{translation:{autonomousGoal:autonomousGoalZhCN}}}});
 return renderToStaticMarkup(React.createElement({bar:GoalStatusBar,details:GoalDetailsDialog,resume:GoalResumeDialog}[kind],{...props,onControl:()=>{},onReload:()=>{},onClose:()=>{},onResume:()=>{},returnFocus:null}));
}
` }, bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", loader: { ".css": "empty" },
  nodePaths: [path.join(root, "apps/desktop/node_modules")], alias: { "@pi-desktop/shared": path.join(root, "packages/shared/src/index.ts") } });
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { render } = module.exports;
const goal = { id: "g", sessionId: "s", revision: 1, status: "paused", objective: "Trace citations", criteria: ["Links survive"], outcomes: [], progressSummary: "", tokenUsage: 200, roundsStarted: 2, budget: { maxTurns: 20 } };

test("compact summary never embeds budget fields or reports in the measured dock", async () => {
  for (const status of ["active", "paused", "blocked", "budget_exhausted", "completed", "cancelled"]) {
    const markup = await render({ goal: { ...goal, status } });
    assert.match(markup, /data-testid="goal-status-bar"/);
    assert.ok(!markup.includes("<input") && !markup.includes("<details") && !markup.includes("<dialog"));
    assert.match(markup, /View goal details/);
    assert.match(markup, /lucide-circle-ellipsis/);
    assert.ok(!markup.includes("lucide-chevron-down"));
    assert.ok(!markup.includes("No progress report"));
    if (["completed", "cancelled"].includes(status)) assert.ok(!/data-goal-action="(?:edit|pause|resume)"/.test(markup));
  }
});

test("pending controls, settled-turn resume and local reload recovery remain visible", async () => {
  const pending = await render({ goal, pending: "resume" });
  assert.match(pending, /aria-busy="true"/); assert.match(pending, /Resuming…/);
  assert.match(pending, /<button[^>]*data-goal-action="resume"[^>]*disabled=""/);
  assert.match(await render({ goal, pending: "cancel" }), /Cancelling…/);
  const error = await render({ goal, error: "revision conflict" });
  assert.match(error, /role="alert"/); assert.match(error, /revision conflict/); assert.match(error, /Reload status/);
  const finishing = await render({ goal: { ...goal, activeTurnId: "turn" } });
  assert.match(finishing, /<button[^>]*data-goal-action="resume"[^>]*disabled=""/);
});

test("details honestly distinguish model reports, missing legacy audit and explicit unlimited budgets", async () => {
  const legacy = await render({ goal: { ...goal, budget: { maxTurns: null } } }, "en", "details");
  assert.match(legacy, /not independently verified by the host/);
  assert.match(legacy, /No structured audit is stored/); assert.match(legacy, /No progress report yet/);
  assert.match(legacy, /2 \/ Unlimited turns/); assert.match(legacy, /200 \/ Unlimited tokens/);
  const audited = await render({ goal: { ...goal, status: "completed", audit: { version: 1, objective: goal.objective, items: [{ requirement: "Full bibliography", outcome: "unverified", evidence: "Export not tested" }], remainingWork: ["Run export"] } } }, "zh-CN", "details");
  assert.match(audited, /当前模型审计/); assert.match(audited, /未验证/); assert.match(audited, /Export not tested/); assert.match(audited, /Run export/);
});

test("exhausted resume uses total limits and cannot submit exhausted caps", async () => {
  const markup = await render({ goal: { ...goal, status: "budget_exhausted", roundsStarted: 20 } }, "en", "resume");
  assert.match(markup, /data-testid="goal-resume-dialog"/); assert.match(markup, /total limits, not additional/);
  assert.ok(!markup.includes("Each finite total limit must be greater") && !markup.includes("Zero or an empty field") && !markup.includes("Token budgets are checked"));
  assert.match(markup, /<button[^>]*type="submit"[^>]*disabled=""/);
});

test("header exposes localized icon actions and host-derived active time without invented legacy time", async () => {
  const realNow = Date.now;
  Date.now = () => 1800000000000;
  try {
    const active = await render({ goal: { ...goal, status: "active", elapsedSeconds: 3600, activeSinceMs: Date.now() - 62000 } });
    assert.match(active, /Running goal/); assert.match(active, /01h01m02s/);
    for (const action of ["edit", "pause", "delete", "details"]) assert.match(active, new RegExp('data-goal-action="'+action+'"'));
    assert.match(active, /aria-label="Edit goal"/); assert.match(active, /aria-label="Pause"/); assert.match(active, /aria-label="Remove goal"/);
    assert.ok(!active.includes('role="menu"') && !active.includes('More goal actions'));
    assert.match(await render({ goal }), /00h00m00s/);
    const paused = await render({ goal: { ...goal, elapsedSeconds: 62, activeSinceMs: Date.now() - 900000 } }, "zh-CN");
    assert.match(paused, /已暂停的目标/); assert.match(paused, /00h01m02s/); assert.match(paused, /aria-label="编辑目标"/);
  } finally { Date.now = realNow; }
});

test("timer zero and minute/hour rollover use compact units in both languages", async () => {
  for (const language of ["en", "zh-CN"]) {
    for (const [elapsedSeconds, expected] of [[0, "00h00m00s"], [59, "00h00m59s"], [60, "00h01m00s"], [3599, "00h59m59s"], [3600, "01h00m00s"], [3661, "01h01m01s"]]) {
      const markup = await render({ goal: { ...goal, elapsedSeconds } }, language);
      assert.ok(markup.includes(`>${expected}</span>`), `${language}: ${expected}`);
    }
  }
});
