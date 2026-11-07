import { useTranslation } from "react-i18next";
import { Input } from "../../components/ui";
import { budgetToDraft, parseGoalBudget, type GoalBudgetDraft } from "./goal-budget";

/** Drafts remain editable; blur/Enter normalize without explanatory or validation text. */
export function GoalBudgetInputs({ value, onChange, disabled = false, onCommit }: {
  value: GoalBudgetDraft;
  onChange: (value: GoalBudgetDraft) => void;
  disabled?: boolean;
  onCommit?: () => void;
}) {
  const { t } = useTranslation();
  const commit = () => {
    if (disabled) return;
    const normalized = budgetToDraft(parseGoalBudget(value));
    if (normalized.turns !== value.turns || normalized.tokens !== value.tokens) onChange(normalized);
    onCommit?.();
  };
  return <div className="goal-budget-inputs">
    {(["turns", "tokens"] as const).map((dimension) => {
      const label = t(dimension === "turns" ? "autonomousGoal.turnLimit" : "autonomousGoal.tokenLimit");
      return <label className="goal-budget-field" key={dimension}>
        <span>{label}</span>
        <Input type="text" inputMode="numeric" autoComplete="off" placeholder={t("autonomousGoal.unlimited")}
          aria-label={label} value={value[dimension]} disabled={disabled}
          onChange={(event) => onChange({ ...value, [dimension]: event.target.value })}
          onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { if (onCommit) event.preventDefault(); commit(); } }} />
      </label>;
    })}
  </div>;
}

export function GoalBudgetFields(props: {
  value: GoalBudgetDraft;
  onChange: (value: GoalBudgetDraft) => void;
  disabled?: boolean;
}) {
  return <div className="goal-budget"><GoalBudgetInputs {...props} /></div>;
}
