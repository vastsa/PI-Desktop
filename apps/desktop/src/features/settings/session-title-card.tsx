/**
 * Session title generation settings (ADR 0322; title flow ADR 0186).
 *
 * The card owns how a new session is named after its first reply: the system
 * prompt (editable as a whole, default = the built-in prompt), the model and
 * reasoning rows that pick which model runs the one-shot, and the two lengths.
 *
 * - The editor opens on the value in force. Saving text equal to the built-in
 *   default (or blank) clears the override instead of storing a frozen copy,
 *   so later improvements to the default still reach users who never
 *   customized it — the same rule as the prompt-enhancement template.
 * - `{{idealLength}}` is optional in a custom prompt. When the prompt in force
 *   does not reference it, the ideal-length row says so instead of silently
 *   doing nothing.
 * - The ideal length is bounded by the truncation length in both rows, so the
 *   prompt never asks for more than is kept; the runtime also clamps.
 * - The 48-character first-prompt fallback title is not configurable: the
 *   auto-title guard recognizes it by exact string equality.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  SESSION_TITLE_DEFAULT_PROMPT,
  SESSION_TITLE_IDEAL_LENGTH_MAX,
  SESSION_TITLE_IDEAL_LENGTH_MIN,
  SESSION_TITLE_IDEAL_LENGTH_VARIABLE,
  SESSION_TITLE_MAX_LENGTH_MAX,
  SESSION_TITLE_MAX_LENGTH_MIN,
  SESSION_TITLE_PROMPT_MAX_LENGTH,
  isCustomSessionTitlePromptActive,
  resolveSessionTitleLengths,
  resolveSessionTitlePrompt,
  sessionTitlePromptUsesIdealLength,
} from "@pi-desktop/shared";
import { Input, TooltipButton } from "../../components/ui";
import { IconPencil } from "../../components/icons";
import { OneShotModelRows } from "../../components/settings/OneShotModelRows";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";
import { OneShotPromptEditorSheet } from "./one-shot-prompt-editor-sheet";

type SaveSettings = (patch: Partial<AppSettings>) => Promise<void>;

export function SessionTitleCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
}) {
  const { t } = useTranslation();
  const [editorOpen, setEditorOpen] = useState(false);
  const overrides = {
    customPrompt: settings.sessionTitleCustomPrompt,
    prompt: settings.sessionTitlePrompt,
  };
  const hasCustomPrompt = isCustomSessionTitlePromptActive(overrides);
  const promptInForce = resolveSessionTitlePrompt(overrides);
  const { idealLength, maxLength } = resolveSessionTitleLengths({
    idealLength: settings.sessionTitleIdealLength,
    maxLength: settings.sessionTitleMaxLength,
  });

  return (
    <SettingsCard
      title={t("settings.sessionTitleTitle")}
      description={t("settings.sessionTitleDesc")}
    >
      <SettingsRow
        title={t("settings.sessionTitleCustomPrompt")}
        description={t("settings.sessionTitleCustomPromptDesc")}
        detail={hasCustomPrompt ? t("settings.sessionTitleCustomPromptActive") : undefined}
      >
        <TooltipButton
          type="button"
          className="settings-icon-button"
          ariaLabel={t("settings.sessionTitleEdit")}
          tooltip={t("settings.sessionTitleEdit")}
          onClick={() => setEditorOpen(true)}
        >
          <IconPencil size={15} />
        </TooltipButton>
      </SettingsRow>

      <OneShotModelRows
        config={{
          providerKey: "sessionTitleProviderId",
          modelKey: "sessionTitleModelId",
          thinkingKey: "sessionTitleThinkingLevel",
          labels: {
            model: t("settings.sessionTitleModel"),
            follow: t("settings.sessionTitleModelFollow"),
            unavailable: t("settings.sessionTitleModelUnavailable"),
            thinking: t("settings.sessionTitleThinking"),
            thinkingDesc: t("settings.sessionTitleThinkingDesc"),
            thinkingOff: t("settings.sessionTitleThinkingOff"),
          },
        }}
      />

      <SessionTitleLengthRow
        title={t("settings.sessionTitleIdealLength")}
        description={t("settings.sessionTitleIdealLengthDesc")}
        detail={
          sessionTitlePromptUsesIdealLength(promptInForce)
            ? undefined
            : t("settings.sessionTitleIdealLengthUnused")
        }
        value={idealLength}
        min={SESSION_TITLE_IDEAL_LENGTH_MIN}
        max={Math.min(SESSION_TITLE_IDEAL_LENGTH_MAX, maxLength)}
        onCommit={(next) => saveSettings({ sessionTitleIdealLength: next })}
      />

      <SessionTitleLengthRow
        title={t("settings.sessionTitleMaxLength")}
        description={t("settings.sessionTitleMaxLengthDesc")}
        value={maxLength}
        min={Math.max(SESSION_TITLE_MAX_LENGTH_MIN, idealLength)}
        max={SESSION_TITLE_MAX_LENGTH_MAX}
        onCommit={(next) => saveSettings({ sessionTitleMaxLength: next })}
      />

      {editorOpen ? (
        <SessionTitlePromptEditorSheet
          settings={settings}
          saveSettings={saveSettings}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </SettingsCard>
  );
}

function SessionTitlePromptEditorSheet({
  settings,
  saveSettings,
  onClose,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const initialValue = resolveSessionTitlePrompt({
    customPrompt: settings.sessionTitleCustomPrompt,
    prompt: settings.sessionTitlePrompt,
  });

  const validate = (draft: string) =>
    [...draft].length > SESSION_TITLE_PROMPT_MAX_LENGTH
      ? t("settings.sessionTitlePromptTooLong")
      : null;

  const save = async (draft: string) => {
    // Blank or default text means "use the built-in prompt".
    const stored = draft === SESSION_TITLE_DEFAULT_PROMPT || !draft.trim() ? "" : draft;
    await saveSettings({
      sessionTitlePrompt: stored,
      sessionTitleCustomPrompt: Boolean(stored),
    });
  };

  return (
    <OneShotPromptEditorSheet
      titleId="session-title-sheet-title"
      copy={{
        title: t("settings.sessionTitleTitle"),
        subtitle: t("settings.sessionTitleDesc"),
        fieldLabel: t("settings.sessionTitlePrompt"),
        fieldHint: t("settings.sessionTitlePromptDesc"),
        insertVariable: t("settings.sessionTitleInsertIdealLength"),
        restoreDefault: t("settings.sessionTitleRestore"),
        saveError: t("settings.sessionTitleSaveError"),
      }}
      initialValue={initialValue}
      defaultValue={SESSION_TITLE_DEFAULT_PROMPT}
      variable={SESSION_TITLE_IDEAL_LENGTH_VARIABLE}
      validate={validate}
      onSave={save}
      onClose={onClose}
    />
  );
}

/**
 * A bounded integer row: commits on blur or Enter, and an out-of-range or
 * non-integer entry reverts to the value in force instead of being clamped,
 * so a typo never silently becomes a different setting.
 */
function SessionTitleLengthRow({
  title,
  description,
  detail,
  value,
  min,
  max,
  onCommit,
}: {
  title: string;
  description: string;
  detail?: string;
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = async () => {
    const parsed = Number(draft.trim());
    const next = Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : value;
    setDraft(String(next));
    if (next === value) return;
    try {
      await onCommit(next);
    } catch {
      setDraft(String(value));
      showToast(t("settings.sessionTitleSaveError"), { variant: "error" });
    }
  };

  return (
    <SettingsRow title={title} description={description} detail={detail}>
      <div className="settings-number-control">
        <Input
          type="number"
          min={min}
          max={max}
          step={1}
          inputMode="numeric"
          value={draft}
          aria-label={title}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}
