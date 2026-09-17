import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import {
  getSessionReferenceBudgetPercent,
  setSessionReferenceBudgetPercent,
} from "../../lib/session-reference-preferences";
import { SettingsRow } from "./primitives";

export function SessionReferenceBudgetRow() {
  const { t } = useTranslation();
  const [percent, setPercent] = useState(getSessionReferenceBudgetPercent);
  return (
    <SettingsRow title={t("settings.sessionReferenceBudget")} description={t("settings.sessionReferenceBudgetDesc")}>
      <SettingsMenuSelect
        label={t("settings.sessionReferenceBudget")}
        value={String(percent)}
        options={[10, 25, 50, 100].map((value) => ({
          id: String(value),
          label: t(value === 25 ? "settings.sessionReferenceBudgetDefault" : "settings.sessionReferenceBudgetOption", { percent: value }),
        }))}
        onChange={(value) => {
          const next = Number(value);
          setSessionReferenceBudgetPercent(next);
          setPercent(next);
        }}
      />
    </SettingsRow>
  );
}
