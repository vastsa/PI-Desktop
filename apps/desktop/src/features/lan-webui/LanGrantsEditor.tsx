import { useTranslation } from "react-i18next";
import type { LanGrants } from "@pi-desktop/shared";
import { Checkbox } from "../../components/ui";
import { IconCheck, IconShield } from "../../components/icons";

export const NEW_DEVICE_GRANTS: LanGrants = {
  projectScope: "all-local",
  temporary: false,
  chat: true,
  organize: true,
};

export function LanGrantsEditor({
  value,
  onChange,
  disabled,
}: {
  value: LanGrants;
  onChange: (next: LanGrants) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("lan");
  const options = [
    { key: "temporary", label: t("scopeTemporary"), hint: t("temporaryHint") },
    { key: "chat", label: t("chat"), hint: t("chatHint") },
    { key: "organize", label: t("organize"), hint: t("organizeHint") },
  ] as const;

  return (
    <div className="lan-grants">
      <div className="lan-grants-list" role="group" aria-label={t("permissions")}>
        <div className="lan-grants-fixed">
          <IconCheck size={14} aria-hidden="true" />
          <span className="lan-grants-option-label">{t("scopeAll")}</span>
        </div>
        {options.map(({ key, label, hint }) => (
          <Checkbox
            key={key}
            className="lan-grants-option"
            label={
              <span className="lan-grants-option-copy">
                <span className="lan-grants-option-label">{label}</span>
                <span className="lan-grants-option-hint">{hint}</span>
              </span>
            }
            checked={value[key]}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, [key]: event.target.checked })}
          />
        ))}
      </div>
      <p className="lan-grants-note">
        <IconShield size={14} aria-hidden="true" />
        {t("approvalsStayHere")}
      </p>
    </div>
  );
}
