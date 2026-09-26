import { useTranslation } from "react-i18next";
import { Button, Field } from "../ui";
import { SubagentModelPicker } from "./SubagentModelPicker";
import {
  groupSubagentModelChoices,
  pinMatchesChoice,
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
  const selected = new Set([primary, ...values].map((pin) => subagentModelSelectValue(pin, choices)));
  const available = choices.filter((choice) => !selected.has(choice.value));
  const rows = values.map((pin) => {
    const choice = choices.find((candidate) => pinMatchesChoice(pin, candidate));
    return { choice, text: choice ? `${choice.providerName}/${choice.modelId}` : pin };
  });
  const move = (index: number, delta: number) => {
    const next = [...values];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return (
    <Field label={t("extensions.subagents.fallbackModels")} hint={t("extensions.subagents.fallbackModelsHint")}>
      <ol className="space-y-2">
        {values.map((pin, index) => {
          const { choice, text } = rows[index];
          const duplicate = rows.some((other, position) => position !== index && other.text === text);
          const sameProvider = choice && rows.some((other, position) =>
            position !== index && other.text === text && other.choice?.providerId === choice.providerId);
          const label = duplicate
            ? `${text} (${!choice || sameProvider ? `${index + 1}: ${pin}` : choice.providerId})`
            : text;
          return (
            <li key={`${index}:${pin}`} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all text-sm">{index + 1}. {label}</span>
              <Button size="sm" variant="secondary" disabled={index === 0} onClick={() => move(index, -1)}
                aria-label={t("extensions.subagents.fallbackMoveUp", { model: label })}>↑</Button>
              <Button size="sm" variant="secondary" disabled={index === values.length - 1} onClick={() => move(index, 1)}
                aria-label={t("extensions.subagents.fallbackMoveDown", { model: label })}>↓</Button>
              <Button size="sm" variant="secondary" onClick={() => onChange(values.filter((_, position) => position !== index))}
                aria-label={t("extensions.subagents.fallbackRemove", { model: label })}>×</Button>
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
