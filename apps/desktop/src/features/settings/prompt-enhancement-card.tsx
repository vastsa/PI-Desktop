/**
 * Prompt-enhancement settings (ADR 0121).
 *
 * This card owns the Composer Enhance prompt action: a switch that chooses
 * between the built-in user template and a saved one, the settings icon button
 * that opens the template editor, and the model plus reasoning rows that pick
 * which model runs the rewrite.
 *
 * What is deliberately not editable: the system prompt. It carries the rewrite
 * contract the feature is verified against (proper-noun preservation, language
 * following without meta notes, the output contract), so it stays a built-in
 * default and host-core drops any stored override.
 *
 * The template field shows the built-in default text when no override is saved,
 * so the editor opens on the value in force, and "restore default" is
 * self-explanatory. Editing the field back to the exact default text clears the
 * override rather than storing a frozen copy, so a later product improvement to
 * the default still reaches users who never customized it.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
  PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH,
  isValidPromptEnhancementUserTemplate,
} from "@pi-desktop/shared";
import { Button, Field, TooltipButton, portalOverlay } from "../../components/ui";
import { IconPencil, IconX } from "../../components/icons";
import { SettingsCard, SettingsRow } from "./primitives";
import { EnhancementModelCard } from "../../components/settings/EnhancementModelCard";

export function PromptEnhancementCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editorOpen, setEditorOpen] = useState(false);
  const hasCustomTemplate = isValidPromptEnhancementUserTemplate(
    settings.promptEnhancementUserTemplate,
  );

  return (
    <SettingsCard title={t("settings.promptEnhancementTitle")}>
      <SettingsRow
        title={t("settings.promptEnhancementCustomTemplate")}
        description={t("settings.promptEnhancementCustomTemplateDesc")}
        detail={
          hasCustomTemplate
            ? t("settings.promptEnhancementCustomTemplateActive")
            : undefined
        }
      >
        <TooltipButton
          type="button"
          className="settings-icon-button"
          ariaLabel={t("settings.promptEnhancementEdit")}
          tooltip={t("settings.promptEnhancementEdit")}
          onClick={() => setEditorOpen(true)}
        >
          <IconPencil size={15} />
        </TooltipButton>
      </SettingsRow>

      <EnhancementModelCard />

      {editorOpen ? (
        <PromptEnhancementEditorSheet
          settings={settings}
          saveSettings={saveSettings}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </SettingsCard>
  );
}

/**
 * The editor itself. Drafts are local until Save, so closing the sheet
 * abandons the edit — the same contract as the subagent editor.
 *
 * Layout follows the ext-sheet design system: head / body / error / actions.
 * Insert Draft and Restore Default are left-side utility buttons in the
 * actions footer, matching SubagentEditorSheet's pattern.
 */
function PromptEnhancementEditorSheet({
  settings,
  saveSettings,
  onClose,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const savedTemplate = settings.promptEnhancementUserTemplate ?? "";
  const [templateDraft, setTemplateDraft] = useState(
    savedTemplate || PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement | null>(null);

  const templateMissingVariable =
    templateDraft.trim().length > 0 &&
    !isValidPromptEnhancementUserTemplate(templateDraft);
  const templateTooLong =
    [...templateDraft].length > PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH;
  const dirty =
    templateDraft !== (savedTemplate || PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const insertDraftVariable = () => {
    const element = templateRef.current;
    if (!element) {
      setTemplateDraft((current) => `${current}${PROMPT_ENHANCEMENT_DRAFT_VARIABLE}`);
      return;
    }
    const start = element.selectionStart ?? templateDraft.length;
    const end = element.selectionEnd ?? start;
    setTemplateDraft(
      `${templateDraft.slice(0, start)}${PROMPT_ENHANCEMENT_DRAFT_VARIABLE}${templateDraft.slice(end)}`,
    );
    const caret = start + PROMPT_ENHANCEMENT_DRAFT_VARIABLE.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const restoreTemplateDefault = () => {
    setTemplateDraft(PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
  };

  const save = async () => {
    if (templateMissingVariable || templateTooLong || saving) return;
    setSaving(true);
    setSaveError(false);
    try {
      const savedTemplateValue =
        templateDraft === PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE
          ? ""
          : templateDraft;
      await saveSettings({
        promptEnhancementUserTemplate: savedTemplateValue,
        promptEnhancementCustomTemplate: Boolean(savedTemplateValue.trim()),
      });
      onClose();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const hasValidationError = templateMissingVariable || templateTooLong;
  const errorMessage = templateMissingVariable
    ? t("settings.promptEnhancementMissingDraftVariable")
    : templateTooLong
      ? t("settings.promptEnhancementTooLong")
      : saveError
        ? t("settings.promptEnhancementSaveError")
        : null;

  return portalOverlay(
    <div
      className="overlay ext-sheet-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="dialog ext-sheet"
        role="dialog"
        aria-modal
        aria-labelledby="prompt-enhancement-sheet-title"
      >
        <div className="ext-sheet-head">
          <div>
            <h3 id="prompt-enhancement-sheet-title" className="ext-sheet-title">
              {t("settings.promptEnhancementTitle")}
            </h3>
            <div className="ext-sheet-sub">
              {t("settings.promptEnhancementDesc")}
            </div>
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
          <Field
            label={t("settings.promptEnhancementUserTemplate")}
            hint={t("settings.promptEnhancementUserTemplateDesc")}
          >
            <textarea
              ref={templateRef}
              className="field-textarea ext-skill-body"
              value={templateDraft}
              rows={10}
              onChange={(event) => setTemplateDraft(event.target.value)}
              aria-label={t("settings.promptEnhancementUserTemplate")}
              aria-invalid={hasValidationError}
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
          <Button variant="ghost" type="button" onClick={insertDraftVariable}>
            {t("settings.promptEnhancementInsertDraft")}
          </Button>
          <Button variant="ghost" type="button" onClick={restoreTemplateDefault}>
            {t("settings.promptEnhancementRestore")}
          </Button>
          <div className="ext-sheet-actions-end">
            <Button variant="ghost" type="button" disabled={saving} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="button"
              disabled={!dirty || saving || hasValidationError}
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
