import { useTranslation } from "react-i18next";
import {
  SUBAGENT_THINKING_LEVELS,
  formatSubagentFallbackEntry,
  parseSubagentFallbackEntry,
  type SubagentThinkingLevel,
} from "@pi-desktop/shared";
import { Button, Field } from "../ui";
import { SubagentModelPicker } from "./SubagentModelPicker";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import {
  groupSubagentModelChoices,
  subagentModelSelectValue,
  type SubagentModelChoice,
} from "./subagent-models";

/** Ordered alternatives use the same configured-model catalog as the primary. */
export function SubagentFallbackModels({ primary, values, choices, onChange }: {
  primary: string;
  values: string[];
  choices: SubagentModelChoice[];
  onChange: (values: string[]) => void;
}) {
  const { t } = useTranslation();
  const selected = new Set([primary, ...values.map((entry) => parseSubagentFallbackEntry(entry).pin)]
    .map((pin) => subagentModelSelectValue(pin, choices)));
  const available = choices.filter((choice) => !selected.has(choice.value));
  const move = (index: number, delta: number) => {
    const next = [...values];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  const replace = (index: number, next: string) => {
    const copy = [...values];
    copy[index] = next;
    onChange(copy);
  };
  const thinkingOptions = [
    { id: "", label: t("extensions.subagents.thinkingInheritDefinition") },
    ...SUBAGENT_THINKING_LEVELS.filter((level) => level !== "omit")
      .map((level) => ({ id: level, label: level })),
  ];
  return (
    <Field label={t("extensions.subagents.fallbackModels")} hint={t("extensions.subagents.fallbackModelsHint")}>
      <ol className="space-y-2">
        {values.map((entry, index) => {
          const parsed = parseSubagentFallbackEntry(entry);
          const pin = parsed.pin;
          return (
            <li key={`${index}:${pin}`} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all text-sm">{index + 1}. {pin}</span>
              <SettingsMenuSelect
                label={t("extensions.subagents.fallbackThinking", { model: pin })}
                value={parsed.thinkingLevel ?? ""}
                onChange={(id) => replace(index, formatSubagentFallbackEntry(pin, id as SubagentThinkingLevel | ""))}
                options={thinkingOptions}
              />
              <Button size="sm" variant="secondary" disabled={index === 0} onClick={() => move(index, -1)}
                aria-label={t("extensions.subagents.fallbackMoveUp", { model: pin })}>↑</Button>
              <Button size="sm" variant="secondary" disabled={index === values.length - 1} onClick={() => move(index, 1)}
                aria-label={t("extensions.subagents.fallbackMoveDown", { model: pin })}>↓</Button>
              <Button size="sm" variant="secondary" onClick={() => onChange(values.filter((_, position) => position !== index))}
                aria-label={t("extensions.subagents.fallbackRemove", { model: pin })}>×</Button>
            </li>
          );
        })}
      </ol>
      <SubagentModelPicker
        value=""
        groups={groupSubagentModelChoices(available)}
        orphanPin={null}
        allowInherit={false}
        disabled={available.length === 0}
        label={t("extensions.subagents.fallbackAdd")}
        emptyLabel={t("extensions.subagents.fallbackAdd")}
        onChange={(pin) => onChange([...values, pin])}
      />
    </Field>
  );
}
