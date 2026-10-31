import { useTranslation } from "react-i18next";
import { HelpIcon } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export function ReasoningEffortSelect({ value, onChange }: {
  value?: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="provider-chosen-reasoning-effort">
      <span className="provider-chosen-thinking-label">
        {t("settings.reasoningEffortParameter")}
        <HelpIcon label={t("settings.reasoningEffortParameterHint")} />
      </span>
      <SettingsMenuSelect
        className="provider-chosen-thinking-select"
        label={t("settings.reasoningEffortParameter")}
        value={value == null ? "auto" : value ? "send" : "omit"}
        onChange={(id) => onChange(id === "auto" ? null : id === "send")}
        options={[
          { id: "auto", label: t("settings.reasoningEffortAuto") },
          { id: "send", label: t("settings.reasoningEffortSend") },
          { id: "omit", label: t("settings.reasoningEffortOmit") },
        ]}
      />
    </div>
  );
}
