import React, { useMemo, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { GoalStatusBar } from "../apps/desktop/src/features/goals/GoalStatusBar";
import { createSessionGoalService, type GoalApi, type GoalEvent } from "../apps/desktop/src/features/goals/session-goal-service";
import type { SessionGoal } from "../packages/shared/src/types/goals";
import { autonomousGoalEn, autonomousGoalZhCN } from "../packages/i18n/src/autonomous-goal";

const zh = new URLSearchParams(location.search).get("lang") === "zh-CN";
await i18n.use(initReactI18next).init({ lng: zh ? "zh-CN" : "en", fallbackLng: "en", resources: {
  en: { translation: { autonomousGoal: autonomousGoalEn } }, "zh-CN": { translation: { autonomousGoal: autonomousGoalZhCN } },
} });
const objective = zh ? "让导出的研究报告保留可追溯的引用" : "Preserve traceable citations in exported research reports";
const criterion = zh ? "每条引用都保留来源链接" : "Every citation retains its source link";
const goals: SessionGoal[] = (["active", "paused", "blocked", "completed", "budget_exhausted", "cancelled"] as const).map((status, index) => ({
  id: `fixture-${index}`, sessionId: `demo-${index}`, revision: 1, status, objective,
  criteria: [criterion, zh ? "导出后可离线阅读" : "Export remains readable offline"],
  progressSummary: zh ? "引用映射已完成，正在检查导出格式。" : "Citation mapping is complete. Checking the exported format.",
  roundsStarted: status === "budget_exhausted" ? 20 : 4, tokenUsage: 12480, budget: { maxTurns: 20, maxTokens: 50000 },
  outcomes: [criterion, zh ? "导出后可离线阅读" : "Export remains readable offline"].map(criterion => ({ criterion, outcome: status === "completed" ? "met" : "unverified", evidence: zh ? "仅为合成示例，不是真实研究证据。" : "Synthetic demonstration, not real research evidence." })),
  ...(status === "completed" ? { audit: { version: 1 as const, objective, items: [{ requirement: objective, outcome: "met" as const, evidence: "Synthetic fixture only." }], remainingWork: [] } } : {}),
}));
// Fixture-only boundary: no preload, provider, network, or running app is used.
function Fixture({ initial }: { initial: SessionGoal }) {
  const service = useMemo(() => {
    let goal = initial;
    const listeners = new Set<(event: GoalEvent) => void>();
    const api: GoalApi = {
      getGoal: async () => ({ goal }),
      onGoalChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      controlGoal: async (request) => {
        goal = { ...goal, revision: goal.revision + 1, status: request.action === "pause" ? "paused" : request.action === "resume" ? "active" : "cancelled", budget: request.budget ?? goal.budget };
        listeners.forEach((listener) => listener({ sessionId: goal.sessionId, goal }));
        return { goal };
      },
    };
    return createSessionGoalService(initial.sessionId, api);
  }, [initial]);
  useEffect(() => service.start(), [service]);
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  return <div data-fixture={initial.status}><GoalStatusBar key={`${state.goal?.budget.maxTurns}`} goal={state.goal ?? initial} pending={state.pending}
    error={state.error} onControl={(action, budget) => void service.control(action, budget)} /></div>;
}
function Preview() {
  const { t } = useTranslation();
  return <main><header><h1>{t("autonomousGoal.title")}</h1><p>{t("autonomousGoal.demo")}</p></header>
    {goals.map((goal) => <Fixture key={goal.id} initial={goal} />)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
