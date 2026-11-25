import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { LanGrants } from "@pi-desktop/shared";
import { Button, Checkbox } from "../../components/ui";
import { IconCheck, IconShield } from "../../components/icons";

export const NEW_DEVICE_GRANTS: LanGrants = { projectIds: [], temporary: false, chat: true, organize: true };

/**
 * What one paired device may see (projects, temporary conversations) and do
 * (chat, organize). Viewing is always allowed and shown as such.
 */
export function LanGrantsEditor({
  projects,
  value,
  onChange,
  disabled = false,
}: {
  projects: Array<{ id: string; label: string }>;
  value: LanGrants;
  onChange: (next: LanGrants) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("lan");
  const listId = useId();
  const allSelected = projects.length > 0 && value.projectIds.length === projects.length;

  const toggleProject = (id: string, on: boolean) =>
    onChange({
      ...value,
      projectIds: on ? [...new Set([...value.projectIds, id])] : value.projectIds.filter((candidate) => candidate !== id),
    });

  return (
    <div className="lan-grants">
      <section className="lan-grants-section" aria-labelledby={`${listId}-projects`}>
        <div className="lan-grants-section-head">
          <h3 id={`${listId}-projects`} className="lan-grants-section-title">{t("projects")}</h3>
          {projects.length ? (
            <span className="lan-grants-section-meta">
              {t("selectedCount", { selected: value.projectIds.length, total: projects.length })}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange({ ...value, projectIds: allSelected ? [] : projects.map((project) => project.id) })}
              >
                {allSelected ? t("selectNone") : t("selectAll")}
              </Button>
            </span>
          ) : null}
        </div>
        <div className="lan-grants-list" role="group" aria-labelledby={`${listId}-projects`}>
          {projects.length ? projects.map((project) => (
            <Checkbox
              key={project.id}
              className="lan-grants-option"
              label={<span className="lan-grants-option-label">{project.label}</span>}
              checked={value.projectIds.includes(project.id)}
              disabled={disabled}
              onChange={(event) => toggleProject(project.id, event.target.checked)}
            />
          )) : <p className="lan-grants-empty">{t("noProjects")}</p>}
          <Checkbox
            className="lan-grants-option lan-grants-option-separate"
            label={
              <span className="lan-grants-option-copy">
                <span className="lan-grants-option-label">{t("scopeTemporary")}</span>
                <span className="lan-grants-option-hint">{t("temporaryHint")}</span>
              </span>
            }
            checked={value.temporary}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, temporary: event.target.checked })}
          />
        </div>
      </section>

      <section className="lan-grants-section" aria-labelledby={`${listId}-abilities`}>
        <div className="lan-grants-section-head">
          <h3 id={`${listId}-abilities`} className="lan-grants-section-title">{t("abilities")}</h3>
        </div>
        <div className="lan-grants-list" role="group" aria-labelledby={`${listId}-abilities`}>
          <div className="lan-grants-fixed">
            <IconCheck size={14} aria-hidden="true" />
            <span className="lan-grants-option-label">{t("alwaysView")}</span>
          </div>
          <Checkbox
            className="lan-grants-option"
            label={
              <span className="lan-grants-option-copy">
                <span className="lan-grants-option-label">{t("chat")}</span>
                <span className="lan-grants-option-hint">{t("chatHint")}</span>
              </span>
            }
            checked={value.chat}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, chat: event.target.checked })}
          />
          <Checkbox
            className="lan-grants-option"
            label={
              <span className="lan-grants-option-copy">
                <span className="lan-grants-option-label">{t("organize")}</span>
                <span className="lan-grants-option-hint">{t("organizeHint")}</span>
              </span>
            }
            checked={value.organize}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, organize: event.target.checked })}
          />
        </div>
      </section>

      <p className="lan-grants-note">
        <IconShield size={14} aria-hidden="true" />
        {t("approvalsStayHere")}
      </p>
    </div>
  );
}
