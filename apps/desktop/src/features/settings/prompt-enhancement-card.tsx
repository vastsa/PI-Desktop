/**
 * Prompt-enhancement settings (ADR 0121).
 *
 * Three controls share one card because they configure one action:
 *  - the model the one-shot enhancement runs on, or "follow the current model";
 *  - the system prompt;
 *  - the user template, which must carry `{{draft}}`.
 *
 * Both template fields show the built-in default when nothing is saved, so the
 * text a user reads is the text the model receives, and "Restore default" is
 * self-explanatory rather than a leap of faith.
 *
 * Comparing an edited field against the default is deliberate: restoring the
 * default text stores an empty override rather than a frozen copy, so a later
 * product change to the defaults still reaches users who never customized them.
 *
 * The user-template field blocks a save that would drop the draft variable.
 * host-core rejects that write too, but a local message explains it better than
 * a protocol error.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
  PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
  isValidPromptEnhancementUserTemplate,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { SettingsCard } from "./primitives";
import { SubagentModelPicker } from "../../components/settings/SubagentModelPicker";
import {
  groupSubagentModelChoices,
  subagentModelChoices,
  subagentModelOrphanPin,
  subagentModelPinParts,
  subagentModelSelectValue,
} from "../../components/settings/subagent-models";

export function PromptEnhancementCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const [systemDraft, setSystemDraft] = useState("");
  const [templateDraft, setTemplateDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement | null>(null);

  const savedSystem = settings.promptEnhancementSystemPrompt ?? "";
  const savedTemplate = settings.promptEnhancementUserTemplate ?? "";

  // A field with no stored override shows the built-in default text, so the
  // user sees what they are replacing.
  useEffect(() => {
    setSystemDraft(savedSystem || PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
  }, [savedSystem]);
  useEffect(() => {
    setTemplateDraft(savedTemplate || PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
  }, [savedTemplate]);

  const choices = useMemo(() => subagentModelChoices(providers), [providers]);
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const pinnedValue = useMemo(() => {
    const providerId = (settings.promptEnhancementProviderId ?? "").trim();
    const modelId = (settings.promptEnhancementModelId ?? "").trim();
    if (!providerId || !modelId) return "";
    return subagentModelSelectValue(`${providerId}/${modelId}`, choices);
  }, [choices, settings.promptEnhancementProviderId, settings.promptEnhancementModelId]);
  const orphanPin = useMemo(
    () => subagentModelOrphanPin(pinnedValue, choices),
    [pinnedValue, choices],
  );

  const templateMissingVariable =
    templateDraft.trim().length > 0 &&
    !isValidPromptEnhancementUserTemplate(templateDraft);
  const systemDirty =
    systemDraft !== (savedSystem || PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
  const templateDirty =
    templateDraft !== (savedTemplate || PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
  const dirty = systemDirty || templateDirty;

  const commit = async (patch: Partial<AppSettings>) => {
    setSaving(true);
    setSaveError(false);
    try {
      await saveSettings(patch);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  /** Store an override, or clear it when the text is the built-in default. */
  const storedTemplateValue = (draft: string, defaultText: string) =>
    draft === defaultText ? "" : draft;

  const save = async () => {
    if (templateMissingVariable) return;
    await commit({
      promptEnhancementSystemPrompt: storedTemplateValue(
        systemDraft,
        PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
      ),
      promptEnhancementUserTemplate: storedTemplateValue(
        templateDraft,
        PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
      ),
    });
  };

  const restoreDefaults = async () => {
    setSystemDraft(PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
    setTemplateDraft(PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
    await commit({
      promptEnhancementSystemPrompt: "",
      promptEnhancementUserTemplate: "",
    });
  };

  const onModelChange = async (next: string) => {
    if (!next) {
      await commit({
        promptEnhancementProviderId: "",
        promptEnhancementModelId: "",
      });
      return;
    }
    const choice = choices.find((candidate) => candidate.value === next);
    if (choice) {
      await commit({
        promptEnhancementProviderId: choice.providerId,
        promptEnhancementModelId: choice.modelId,
      });
      return;
    }
    // An orphan pin keeps its provider half; only the model half is knowable.
    const parts = subagentModelPinParts(next);
    await commit({
      promptEnhancementProviderId: "",
      promptEnhancementModelId: parts?.modelId ?? "",
    });
  };

  const insertDraftVariable = () => {
    const element = templateRef.current;
    if (!element) {
      setTemplateDraft((current) => `${current}${PROMPT_ENHANCEMENT_DRAFT_VARIABLE}`);
      return;
    }
    const start = element.selectionStart ?? templateDraft.length;
    const end = element.selectionEnd ?? start;
    const next = `${templateDraft.slice(0, start)}${PROMPT_ENHANCEMENT_DRAFT_VARIABLE}${templateDraft.slice(end)}`;
    setTemplateDraft(next);
    const caret = start + PROMPT_ENHANCEMENT_DRAFT_VARIABLE.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  return (
    <SettingsCard title={t("settings.promptEnhancementTitle")}>
      <div className="settings-form-grid">
        <div className="settings-row-copy">
          <div className="settings-row-desc">{t("settings.promptEnhancementDesc")}</div>
        </div>
      </div>

      <div className="settings-form-grid">
        <div className="settings-row-copy">
          <div className="settings-row-title">{t("settings.promptEnhancementModel")}</div>
          <div className="settings-row-desc">
            {t("settings.promptEnhancementModelDesc")}
          </div>
        </div>
        <SubagentModelPicker
          value={pinnedValue}
          groups={groups}
          orphanPin={orphanPin}
          label={t("settings.promptEnhancementModel")}
          emptyLabel={t("settings.promptEnhancementModelFollow")}
          onChange={(next) => void onModelChange(next)}
        />
      </div>

      <div className="settings-form-grid">
        <div className="settings-row-copy">
          <div className="settings-row-title">
            {t("settings.promptEnhancementSystemPrompt")}
          </div>
          <div className="settings-row-desc">
            {t("settings.promptEnhancementSystemPromptDesc")}
          </div>
        </div>
        <textarea
          className="field-textarea settings-instruction-editor"
          value={systemDraft}
          onChange={(event) => setSystemDraft(event.target.value)}
          aria-label={t("settings.promptEnhancementSystemPrompt")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      <div className="settings-form-grid">
        <div className="settings-row-copy">
          <div className="settings-row-title">
            {t("settings.promptEnhancementUserTemplate")}
          </div>
          <div className="settings-row-desc">
            {t("settings.promptEnhancementUserTemplateDesc")}
          </div>
        </div>
        <textarea
          ref={templateRef}
          className="field-textarea settings-instruction-editor"
          value={templateDraft}
          onChange={(event) => setTemplateDraft(event.target.value)}
          aria-label={t("settings.promptEnhancementUserTemplate")}
          aria-invalid={templateMissingVariable}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        {templateMissingVariable ? (
          <span className="settings-command-shell-state error" role="status">
            {t("settings.promptEnhancementMissingDraftVariable")}
          </span>
        ) : null}
        <div className="settings-panel-actions">
          <Button variant="secondary" type="button" onClick={insertDraftVariable}>
            {t("settings.promptEnhancementInsertDraft")}
          </Button>
        </div>
      </div>

      {saveError ? (
        <span className="settings-command-shell-state error" role="status">
          {t("settings.promptEnhancementSaveError")}
        </span>
      ) : null}

      <div className="settings-panel-actions">
        <Button
          variant="primary"
          disabled={!dirty || saving || templateMissingVariable}
          onClick={() => void save()}
        >
          {saving ? t("settings.saving") : t("settings.instructionsSave")}
        </Button>
        <Button
          variant="secondary"
          type="button"
          disabled={saving}
          onClick={() => void restoreDefaults()}
        >
          {t("settings.promptEnhancementRestoreAll")}
        </Button>
      </div>
    </SettingsCard>
  );
}
