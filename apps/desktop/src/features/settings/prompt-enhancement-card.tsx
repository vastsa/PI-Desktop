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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
  PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH,
  isValidPromptEnhancementUserTemplate,
} from "@pi-desktop/shared";
import { TooltipButton } from "../../components/ui";
import { IconPencil } from "../../components/icons";
import { SettingsCard, SettingsRow } from "./primitives";
import { EnhancementModelCard } from "../../components/settings/EnhancementModelCard";
import { OneShotPromptEditorSheet } from "./one-shot-prompt-editor-sheet";

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
 * The editor binds the shared one-shot prompt sheet to the user template.
 * A save that would drop the draft variable or exceed the host-core bound is
 * refused before it is sent.
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

  const validate = (templateDraft: string) => {
    const templateMissingVariable =
      templateDraft.trim().length > 0 &&
      !isValidPromptEnhancementUserTemplate(templateDraft);
    const templateTooLong =
      [...templateDraft].length > PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH;
    if (templateMissingVariable) return t("settings.promptEnhancementMissingDraftVariable");
    if (templateTooLong) return t("settings.promptEnhancementTooLong");
    return null;
  };

  const save = async (templateDraft: string) => {
    const savedTemplateValue =
      templateDraft === PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE ? "" : templateDraft;
    await saveSettings({
      promptEnhancementUserTemplate: savedTemplateValue,
      promptEnhancementCustomTemplate: Boolean(savedTemplateValue.trim()),
    });
  };

  return (
    <OneShotPromptEditorSheet
      titleId="prompt-enhancement-sheet-title"
      copy={{
        title: t("settings.promptEnhancementTitle"),
        subtitle: t("settings.promptEnhancementDesc"),
        fieldLabel: t("settings.promptEnhancementUserTemplate"),
        fieldHint: t("settings.promptEnhancementUserTemplateDesc"),
        insertVariable: t("settings.promptEnhancementInsertDraft"),
        restoreDefault: t("settings.promptEnhancementRestore"),
        saveError: t("settings.promptEnhancementSaveError"),
      }}
      initialValue={savedTemplate || PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE}
      defaultValue={PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE}
      variable={PROMPT_ENHANCEMENT_DRAFT_VARIABLE}
      validate={validate}
      onSave={save}
      onClose={onClose}
    />
  );
}
