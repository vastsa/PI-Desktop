import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "@pi-desktop/shared";
import { IconClose, IconSearch } from "../icons";
import { TooltipButton } from "../ui";
import { selectedSubagentModels, type SubagentModelCandidate } from "./subagent-delegation";

/**
 * The models the AI may pick when it delegates, listed the way a service lists
 * its added models — same search field, same row, same Advanced button, same
 * remove control.
 *
 * Only the opted-in models appear. Adding is not this page's job: a model joins
 * the list by ticking **Available for AI delegation** in that model's own editor,
 * which is exactly where Advanced goes. Both surfaces read and write
 * `availableForSubagents` on the binding, so neither can drift from the other.
 */
export function SubagentModelRow({
  candidates,
  busy = false,
  onChange,
  onEdit,
}: {
  candidates: SubagentModelCandidate[];
  busy?: boolean;
  onChange: (candidate: SubagentModelCandidate, selected: boolean) => void;
  /** Opens the owning service's model editor, where the opt-in is ticked. */
  onEdit: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const selected = selectedSubagentModels(candidates);
  // Nothing configured yet: the page hides this row rather than showing a list
  // that can neither be filled nor emptied.
  if (candidates.length === 0) return null;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? selected.filter((candidate) =>
        `${candidate.providerName} ${candidate.label}`.toLowerCase().includes(needle),
      )
    : selected;
  const name = (candidate: SubagentModelCandidate) =>
    `${candidate.providerName} · ${candidate.label}`;

  return (
    <div className="provider-chosen model-subagent-panel">
      <div className="provider-chosen-head">
        <h4 className="provider-chosen-title">{t("settings.subagentModels")}</h4>
        <span className="provider-chosen-count">{selected.length}</span>
        <div className="provider-chosen-search-wrap">
          <IconSearch size={13} aria-hidden />
          <input
            className="provider-chosen-search"
            value={query}
            placeholder={t("settings.searchChosenModels")}
            aria-label={t("settings.searchChosenModels")}
            disabled={busy || selected.length === 0}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <p className="model-subagent-hint">{t("settings.subagentModelAdd")}</p>
      {selected.length === 0 ? (
        <div className="provider-chosen-empty">{t("settings.subagentModelsUnset")}</div>
      ) : visible.length === 0 ? (
        <div className="provider-chosen-empty">{t("settings.noChosenModelMatches")}</div>
      ) : (
        <ul className="provider-chosen-list">
          {visible.map((candidate) => (
            <li
              className="provider-chosen-row"
              key={`${candidate.providerId}:${candidate.modelId}`}
            >
              <div className="provider-chosen-row-head">
                <span className="provider-chosen-row-id font-mono selectable">
                  {candidate.label}
                </span>
                <span className="model-subagent-provider">{candidate.providerName}</span>
                <span className="provider-chosen-row-limits">
                  {formatTokenCount(candidate.contextWindow)} ·{" "}
                  {formatTokenCount(candidate.maxTokens)}
                </span>
                {candidate.blocked ? (
                  <span className="model-subagent-note">
                    {t(
                      candidate.blocked === "provider-disabled"
                        ? "settings.subagentModelProviderDisabled"
                        : "settings.subagentModelCredentialMissing",
                    )}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="provider-chosen-advanced-toggle"
                  onClick={() => onEdit(candidate.providerId)}
                >
                  {t("settings.advanced")}
                </button>
                {candidate.editable ? (
                  <TooltipButton
                    type="button"
                    className="provider-chosen-remove"
                    ariaLabel={t("settings.subagentModelRemove", { model: name(candidate) })}
                    tooltip={t("settings.subagentModelRemove", { model: name(candidate) })}
                    disabled={busy}
                    onClick={() => onChange(candidate, false)}
                  >
                    <IconClose size={12} />
                  </TooltipButton>
                ) : (
                  <span className="model-subagent-note">
                    {t("settings.subagentModelPluginManaged")}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
