import { useTranslation } from "react-i18next";
import { Checkbox } from "../ui";
import { SettingsDisclosure } from "./SettingsDisclosure";
import {
  groupSubagentModels,
  selectedSubagentModels,
  type SubagentModelCandidate,
} from "./subagent-delegation";

/**
 * Which models the AI may pick when it delegates a run, and the editor for it.
 *
 * The row sits next to the image-model row because both answer the same
 * question — "which models did I hand to the app for this job?" — and both read
 * their state from where the runtime reads it, so the summary can never claim a
 * model the delegation catalog does not contain. Editing stays behind the same
 * disclosure: the row is the answer, the list is how it changes.
 */
export function SubagentModelRow({
  candidates,
  busy = false,
  onToggle,
}: {
  candidates: SubagentModelCandidate[];
  busy?: boolean;
  onToggle: (candidate: SubagentModelCandidate, selected: boolean) => void;
}) {
  const { t } = useTranslation();
  const selected = selectedSubagentModels(candidates);
  // Nothing configured yet: the page hides this row rather than offering an
  // editor with no rows in it.
  if (candidates.length === 0) return null;
  const groups = groupSubagentModels(candidates);

  return (
    <>
      <div className="settings-row model-default-row model-subagent-row">
        <div className="settings-row-copy model-default-copy">
          <div className="settings-row-title model-default-label">
            {t("settings.subagentModels")}
          </div>
          <div className="settings-row-detail model-default-value">
            {selected.length > 0 ? (
              selected.map((candidate) => (
                <span
                  key={`${candidate.providerId}:${candidate.modelId}`}
                  className="model-subagent-chip"
                >
                  <span className="model-default-provider">{candidate.providerName}</span>
                  <span className="model-default-sep" aria-hidden>
                    ·
                  </span>
                  <span className="model-default-model font-mono">{candidate.label}</span>
                </span>
              ))
            ) : (
              <span className="model-default-empty" role="status">
                {t("settings.subagentModelsUnset")}
              </span>
            )}
          </div>
        </div>
      </div>
      <SettingsDisclosure className="model-subagent-editor" title={t("settings.subagentModelsEdit")}>
        <p className="model-subagent-hint">{t("settings.subagentModelsHint")}</p>
        <div className="model-subagent-options">
          {groups.map((group) => (
            <div
              key={group.providerId}
              className="model-subagent-group"
              role="group"
              aria-label={group.providerName}
            >
              <div className="model-subagent-group-title">{group.providerName}</div>
              {group.candidates.map((candidate) => (
                <Checkbox
                  key={`${candidate.providerId}:${candidate.modelId}`}
                  className="model-subagent-option"
                  checked={candidate.selected}
                  disabled={busy || !candidate.editable}
                  label={
                    <>
                      <span className="model-subagent-option-label font-mono">
                        {candidate.label}
                      </span>
                      {!candidate.editable ? (
                        <span className="model-subagent-option-note">
                          {t("settings.subagentModelPluginManaged")}
                        </span>
                      ) : candidate.selected && candidate.blocked ? (
                        <span className="model-subagent-option-note">
                          {t(
                            candidate.blocked === "provider-disabled"
                              ? "settings.subagentModelProviderDisabled"
                              : "settings.subagentModelCredentialMissing",
                          )}
                        </span>
                      ) : null}
                    </>
                  }
                  onChange={(event) => onToggle(candidate, event.target.checked)}
                />
              ))}
            </div>
          ))}
        </div>
      </SettingsDisclosure>
    </>
  );
}
