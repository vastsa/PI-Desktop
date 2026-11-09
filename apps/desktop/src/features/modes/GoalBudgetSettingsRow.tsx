import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, ModeRunBudget } from "@pi-desktop/shared";
import { Input } from "../../components/ui";
import { SettingsRow } from "../settings/primitives";
import { modeBudgetFieldText, parseModeBudgetField } from "./mode-run-model";
import "../../styles/modes.css";

/** Builtin Goal budget (`goal` mode definition), used when the setting is absent. */
export const GOAL_DEFAULT_BUDGET: ModeRunBudget = { maxTurns: 20, maxTokens: null };

export function goalBudgetSetting(settings: Pick<AppSettings, "goalBudget">): ModeRunBudget {
  return settings.goalBudget ?? GOAL_DEFAULT_BUDGET;
}

/**
 * Settings → Agent behavior: the budget a new Goal run starts with. A field
 * saves on blur or Enter; empty is unlimited, an out-of-range value reverts.
 * Runs already open keep their own budget (edit those from the run bar).
 */
export function GoalBudgetSettingsRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const saved = goalBudgetSetting(settings);
  const [text, setText] = useState(() => ({
    maxTurns: modeBudgetFieldText(saved.maxTurns),
    maxTokens: modeBudgetFieldText(saved.maxTokens),
  }));
  useEffect(() => {
    setText({ maxTurns: modeBudgetFieldText(saved.maxTurns), maxTokens: modeBudgetFieldText(saved.maxTokens) });
  }, [saved.maxTurns, saved.maxTokens]);

  const commit = (field: keyof ModeRunBudget) => {
    const value = parseModeBudgetField(text[field], field);
    if (value === undefined) {
      setText((current) => ({ ...current, [field]: modeBudgetFieldText(saved[field]) }));
      return;
    }
    if (value === saved[field]) return;
    void saveSettings({ goalBudget: { ...saved, [field]: value } });
  };
  const onKeyDown = (field: keyof ModeRunBudget) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(field);
    }
  };

  return (
    <SettingsRow title={t("settings.goalBudget")} description={t("settings.goalBudgetDesc")}>
      <div className="settings-goal-budget">
        {(["maxTurns", "maxTokens"] as const).map((field) => {
          const label = t(field === "maxTurns" ? "settings.goalBudgetTurns" : "settings.goalBudgetTokens");
          return (
            <label key={field} className="settings-goal-budget-field">
              <span>{label}</span>
              <Input
                className="settings-goal-budget-input"
                inputMode="numeric"
                placeholder={t("modes.run.unlimited")}
                value={text[field]}
                onChange={(event) => setText((current) => ({ ...current, [field]: event.target.value }))}
                onBlur={() => commit(field)}
                onKeyDown={onKeyDown(field)}
              />
            </label>
          );
        })}
      </div>
    </SettingsRow>
  );
}
