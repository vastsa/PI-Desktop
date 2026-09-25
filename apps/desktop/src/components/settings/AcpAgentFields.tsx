/**
 * External ACP agent settings for a provider row.
 *
 * A row with an agent is a different kind of thing from a row with a base URL:
 * the program brings its own models and credentials, so the endpoint, API
 * format and API key are all unused. The form says so rather than letting the
 * user fill in fields that will be ignored.
 *
 * Commands are launched directly, never through a shell. When a command can
 * only be started through one, that is surfaced here — it is a materially
 * different thing from a command that is simply not installed, and the user
 * should see which one they have before saving.
 *
 * The access model is stated plainly, because it is the part that decides
 * whether saving this row is reasonable: the agent edits the project folder
 * with its own tools and never asks the host, so the host cannot allow or deny
 * any of it. The rules behind the tick box are in `acp-draft.ts`, where they
 * are testable without a JSX runtime.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Checkbox, Field, HelpIcon, Input } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import {
  ACP_PRESETS,
  type AcpDraft,
  acpDraftEdited,
  validateAcpDraft,
} from "./acp-draft";

/**
 * This component is renderer code, so it cannot import `@pi-desktop/acp-client`:
 * that package spawns processes and reads the filesystem, which only the main
 * process can do. Validation here is therefore syntactic only. Whether the
 * command can actually be launched is decided in main by `resolveAcpExecutable`
 * when the session starts, and a failure surfaces as a turn error.
 */

type Props = {
  draft: AcpDraft;
  onChange: (next: AcpDraft) => void;
  /** Lets the dialog refuse to save an unusable or unacknowledged command. */
  onValidity?: (valid: boolean) => void;
};

export function AcpAgentFields({ draft, onChange, onValidity }: Props) {
  const { t } = useTranslation();
  const [presetId, setPresetId] = useState("");

  const problem = useMemo(() => validateAcpDraft(draft), [draft]);
  onValidity?.(problem === null);

  return (
    <section className="provider-acp" aria-label={t("settings.acpSection")}>
      <div className="provider-acp-head">
        <Checkbox
          checked={draft.enabled}
          onChange={(event) => onChange(acpDraftEdited(draft, { enabled: event.target.checked }))}
          label={t("settings.acpEnable")}
        />
        {draft.enabled ? (
          <SettingsMenuSelect
            label={t("settings.acpChoosePreset")}
            value={presetId}
            onChange={(id) => {
              setPresetId(id);
              const preset = ACP_PRESETS.find((p) => p.id === id);
              // Routed through the same edit helper as the text field, so a
              // preset counts as choosing a different program and drops any
              // acknowledgement given for the previous one.
              if (preset) {
                onChange(acpDraftEdited(draft, { command: preset.command, args: preset.args }));
              }
            }}
            options={[
              { id: "", label: t("settings.acpChoosePreset") },
              ...ACP_PRESETS.map((preset) => ({ id: preset.id, label: preset.label })),
            ]}
          />
        ) : null}
      </div>

      {draft.enabled ? (
        <>
          <p className="text-xs text-text-muted">{t("settings.acpExplanation")}</p>
          <p className="provider-acp-access" role="note">
            <HelpIcon label={t("settings.acpAccessWhat")} />
            <span>{t("settings.acpAccessNotice")}</span>
          </p>
          <Field label={t("settings.acpCommand")}>
            <Input
              value={draft.command}
              placeholder="opencode"
              onChange={(event) => onChange(acpDraftEdited(draft, { command: event.target.value }))}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field label={t("settings.acpArgs")}>
            <Input
              value={draft.args}
              placeholder="acp"
              onChange={(event) => onChange(acpDraftEdited(draft, { args: event.target.value }))}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field label={t("settings.acpModel")}>
            <Input
              value={draft.modelId}
              placeholder={t("settings.acpModelPlaceholder")}
              onChange={(event) => onChange(acpDraftEdited(draft, { modelId: event.target.value }))}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Checkbox
            className="provider-acp-consent"
            checked={draft.acknowledged}
            onChange={(event) => onChange(acpDraftEdited(draft, { acknowledged: event.target.checked }))}
            label={t("settings.acpConsent")}
          />
          {problem === "consentRequired" ? (
            <p className="provider-setup-field-error" role="status">
              {t("settings.acpConsentRequired")}
            </p>
          ) : null}
          {problem === "emptyCommand" ? (
            <p className="provider-setup-field-error" role="status">
              {t("settings.acpCommandRequired")}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
