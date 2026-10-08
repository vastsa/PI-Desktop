/**
 * Prompt editor sheet shared by the one-shot settings cards (prompt
 * enhancement, ADR 0121; session title generation, ADR 0322).
 *
 * Drafts are local until Save, so closing the sheet (Esc, backdrop, close
 * button, Cancel) abandons the edit — the same contract as the subagent editor.
 *
 * Layout follows the ext-sheet design system: head / body / error / actions.
 * Insert-variable and Restore Default are left-side utility buttons in the
 * actions footer, matching SubagentEditorSheet's pattern.
 *
 * The caller owns validation and persistence: `validate` returns the message
 * that blocks Save (or null), and `onSave` receives the draft and decides how
 * to store it (for example, clearing the override when it equals the default).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, TooltipButton, portalOverlay } from "../../components/ui";
import { IconX } from "../../components/icons";

export type OneShotPromptEditorCopy = {
  title: string;
  subtitle: string;
  fieldLabel: string;
  fieldHint: string;
  insertVariable: string;
  restoreDefault: string;
  saveError: string;
};

export function OneShotPromptEditorSheet({
  titleId,
  copy,
  initialValue,
  defaultValue,
  variable,
  validate,
  onSave,
  onClose,
}: {
  /** DOM id for the dialog heading; unique per feature. */
  titleId: string;
  /** Already-translated copy. */
  copy: OneShotPromptEditorCopy;
  /** The value in force when the sheet opens (saved override or default). */
  initialValue: string;
  /** The built-in default restored by "Restore default". */
  defaultValue: string;
  /** The placeholder inserted at the caret by the insert button. */
  variable: string;
  validate: (draft: string) => string | null;
  onSave: (draft: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const validationError = validate(draft);
  const dirty = draft !== initialValue;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const insertVariable = () => {
    const element = textareaRef.current;
    if (!element) {
      setDraft((current) => `${current}${variable}`);
      return;
    }
    const start = element.selectionStart ?? draft.length;
    const end = element.selectionEnd ?? start;
    setDraft(`${draft.slice(0, start)}${variable}${draft.slice(end)}`);
    const caret = start + variable.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const save = async () => {
    if (validationError || saving) return;
    setSaving(true);
    setSaveError(false);
    try {
      await onSave(draft);
      onClose();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const errorMessage = validationError ?? (saveError ? copy.saveError : null);

  return portalOverlay(
    <div
      className="overlay ext-sheet-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div className="dialog ext-sheet" role="dialog" aria-modal aria-labelledby={titleId}>
        <div className="ext-sheet-head">
          <div>
            <h3 id={titleId} className="ext-sheet-title">
              {copy.title}
            </h3>
            <div className="ext-sheet-sub">{copy.subtitle}</div>
          </div>
          <TooltipButton
            type="button"
            className="ext-sheet-close"
            ariaLabel={t("common.close")}
            tooltip={t("common.close")}
            onClick={() => {
              if (!saving) onClose();
            }}
            disabled={saving}
          >
            <IconX size={14} />
          </TooltipButton>
        </div>

        <div className="ext-sheet-body">
          <Field label={copy.fieldLabel} hint={copy.fieldHint}>
            <textarea
              ref={textareaRef}
              className="field-textarea ext-skill-body"
              value={draft}
              rows={10}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={copy.fieldLabel}
              aria-invalid={validationError !== null}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </Field>
        </div>

        {errorMessage ? (
          <p className="ext-sheet-error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <div className="ext-sheet-actions">
          <Button variant="ghost" type="button" onClick={insertVariable}>
            {copy.insertVariable}
          </Button>
          <Button variant="ghost" type="button" onClick={() => setDraft(defaultValue)}>
            {copy.restoreDefault}
          </Button>
          <div className="ext-sheet-actions-end">
            <Button variant="ghost" type="button" disabled={saving} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="button"
              disabled={!dirty || saving || validationError !== null}
              onClick={() => void save()}
            >
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
  );
}
