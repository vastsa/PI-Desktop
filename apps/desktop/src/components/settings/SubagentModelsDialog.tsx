import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "@pi-desktop/shared";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { IconClose, IconSearch } from "../icons";
import { Button, OverlayBackdrop, TooltipButton } from "../ui";
import {
  selectedSubagentModels,
  servicesWithAddableModels,
  type SubagentModelCandidate,
} from "./subagent-delegation";

/**
 * The subagent delegation editor: the models the AI may pick when it delegates,
 * listed the way a service lists its added models — same search field, same row,
 * same Advanced button, same remove control.
 *
 * Adding is not this dialog's job: a model joins the list by ticking **Available
 * for AI delegation** in that model's own editor, which is exactly where Advanced
 * goes. Both surfaces read and write `availableForSubagents` on the binding, so
 * neither can drift from the other.
 *
 * While a removal is in flight the whole dialog stops navigating: Advanced and
 * Close are disabled, because a service editor opened from the pre-refresh
 * snapshot would save that stale model list back and undo the removal.
 */
export function SubagentModelsDialog({
  candidates,
  busy = false,
  onChange,
  onEdit,
  onClose,
}: {
  candidates: SubagentModelCandidate[];
  busy?: boolean;
  onChange: (candidate: SubagentModelCandidate, selected: boolean) => void;
  /** Opens the owning service's model editor, where the opt-in is ticked. */
  onEdit: (providerId: string) => void;
  onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // The page passes an inline arrow, so keying the focus effect on `onClose`
  // would re-run it on every parent render (a removal toggles page state) and
  // move the caret out of whatever field the user was in.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const selected = selectedSubagentModels(candidates);
  const targets = servicesWithAddableModels(candidates);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? selected.filter((candidate) =>
        `${candidate.providerName} ${candidate.label}`.toLowerCase().includes(needle),
      )
    : selected;
  const name = (candidate: SubagentModelCandidate) =>
    `${candidate.providerName} · ${candidate.label}`;

  // Focus on open, Escape to close, Tab stays inside, and the trigger gets the
  // focus back on close. Same contract as the other settings dialogs.
  // Focus on open, Escape to close, Tab stays inside, and the trigger gets the
  // focus back on close. Same contract as the other settings dialogs, installed
  // once per mount.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const dialog = (
    <OverlayBackdrop
      className="overlay project-create-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog model-subagent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-subagent-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-create-dialog-head">
          <div className="project-create-dialog-heading">
            <h2 id="model-subagent-dialog-title" className="project-create-dialog-title">
              {t("settings.subagentModels")}
            </h2>
            <p className="project-edit-dialog-description">
              {t("settings.subagentModelAdd")}
            </p>
          </div>
          <TooltipButton
            ref={closeRef}
            type="button"
            className="project-create-dialog-close"
            tooltip={t("common.close")}
            ariaLabel={t("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={17} />
          </TooltipButton>
        </div>

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
          {selected.length === 0 ? (
            // The dialog cannot tick the first model itself, so the empty state
            // names the one place that can: each service's own model editor.
            <div className="provider-chosen-empty model-subagent-empty">
              <p>{t("settings.subagentModelsUnset")}</p>
              {targets.length > 0 ? (
                <div className="model-subagent-empty-actions">
                  {targets.map((target) => (
                    <Button
                      key={target.providerId}
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => onEdit(target.providerId)}
                    >
                      {t("settings.subagentModelOpenService", {
                        provider: target.providerName,
                      })}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
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
                    {candidate.editable ? (
                      <>
                        <button
                          type="button"
                          className="provider-chosen-advanced-toggle"
                          disabled={busy}
                          onClick={() => onEdit(candidate.providerId)}
                        >
                          {t("settings.advanced")}
                        </button>
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
                      </>
                    ) : (
                      // A plugin owns this row: it has no editor to open and
                      // `providers.update` refuses it, so neither Advanced nor a
                      // remove control is offered here.
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

        <div className="model-subagent-dialog-actions">
          <Button variant="primary" disabled={busy} onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </OverlayBackdrop>
  );

  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
