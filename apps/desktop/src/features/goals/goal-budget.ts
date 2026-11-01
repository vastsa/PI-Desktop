import { DEFAULT_GOAL_BUDGET, type GoalBudget } from "@pi-desktop/shared";

export type GoalBudgetDraft = { turns: string; tokens: string };
export function budgetToDraft(budget: GoalBudget = DEFAULT_GOAL_BUDGET): GoalBudgetDraft {
  return { turns: budget.maxTurns === null ? "" : String(budget.maxTurns), tokens: budget.maxTokens === undefined ? "" : String(budget.maxTokens) };
}
/** UI input only: each non-finite-cap draft becomes the canonical unlimited value. */
export function parseGoalBudget(draft: GoalBudgetDraft): GoalBudget {
  const cap = (value: string, max: number) => {
    const text = value.trim();
    const number = Number(text);
    return /^\d+$/.test(text) && Number.isSafeInteger(number) && number >= 1 && number <= max ? number : undefined;
  };
  const maxTurns = cap(draft.turns, 10000) ?? null;
  const maxTokens = cap(draft.tokens, Number.MAX_SAFE_INTEGER);
  return { maxTurns, ...(maxTokens === undefined ? {} : { maxTokens }) };
}
/** Resume caps are total limits, not additional usage. */
export function budgetAllowsResume(budget: GoalBudget, roundsStarted: number, tokenUsage: number): boolean {
  return (budget.maxTurns === null || budget.maxTurns > roundsStarted)
    && (budget.maxTokens === undefined || budget.maxTokens > tokenUsage);
}
