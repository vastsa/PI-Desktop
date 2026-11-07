import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, GoalBudget } from "@pi-desktop/shared";
import { GoalBudgetInputs } from "../goals/GoalBudgetFields";
import { budgetToDraft, parseGoalBudget, type GoalBudgetDraft } from "../goals/goal-budget";
import { SettingsRow } from "./primitives";
import "../goals/goal.css";

function sameBudget(left: GoalBudget | undefined, right: GoalBudget | undefined) {
  return left?.maxTurns === right?.maxTurns && left?.maxTokens === right?.maxTokens;
}

/** Defaults autosave only; session state and execution authority never enter this row. */
export function GoalBudgetRow({ settings, saveSettings }: {
  settings: Pick<AppSettings, "defaultGoalBudget">;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => budgetToDraft(settings.defaultGoalBudget));
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const version = useRef(0);
  const draftRef = useRef(draft);
  const submitted = useRef<GoalBudget | undefined>(undefined);
  const persisted = useRef(parseGoalBudget(budgetToDraft(settings.defaultGoalBudget)));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  const turns = settings.defaultGoalBudget?.maxTurns;
  const tokens = settings.defaultGoalBudget?.maxTokens;
  useEffect(() => {
    const incoming = turns === undefined ? undefined : { maxTurns: turns, ...(tokens === undefined ? {} : { maxTokens: tokens }) };
    if (!sameBudget(incoming, submitted.current)) version.current++;
    const next = budgetToDraft(incoming);
    draftRef.current = next; setDraft(next);
    persisted.current = parseGoalBudget(next);
  }, [turns, tokens]);
  const changed = (next: GoalBudgetDraft) => {
    version.current++; draftRef.current = next; setDraft(next);
  };
  const save = async () => {
    const budget = parseGoalBudget(draftRef.current);
    if (inFlight.current || sameBudget(budget, persisted.current)) return;
    const owner = version.current;
    inFlight.current = true; submitted.current = budget; setSaving(true);
    try {
      await saveSettings({ defaultGoalBudget: budget });
      if (mounted.current && version.current === owner) persisted.current = budget;
    } catch (cause) {
      console.error("Goal defaults persistence failed", cause instanceof Error ? cause.name : "UnknownError");
      if (mounted.current && version.current === owner) {
        const previous = budgetToDraft(persisted.current);
        draftRef.current = previous; setDraft(previous);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return <div data-testid="goal-budget-settings" className="goal-budget-settings" aria-busy={saving}>
    <SettingsRow title={t("autonomousGoal.budgetRegion")}>
      <GoalBudgetInputs value={draft} onChange={changed} disabled={saving} onCommit={() => void save()} />
    </SettingsRow>
  </div>;
}
