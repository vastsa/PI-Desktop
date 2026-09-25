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
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Field, Input } from "../ui";

/**
 * This component is renderer code, so it cannot import `@pi-desktop/acp-client`:
 * that package spawns processes and reads the filesystem, which only the main
 * process can do. Validation here is therefore syntactic only. Whether the
 * command can actually be launched is decided in main by `resolveAcpExecutable`
 * when the session starts, and a failure surfaces as a turn error.
 */

/** Known agents offered as one-click fills. */
const PRESETS = [
  { id: "opencode", label: "OpenCode", command: "opencode", args: "acp" },
] as const;

export type AcpAgentConfigLike = { command: string; args: string[]; modelId?: string };

export type AcpDraft = {
  enabled: boolean;
  command: string;
  args: string;
  modelId: string;
};

export function acpDraftFrom(provider?: { acp?: AcpAgentConfigLike } | null): AcpDraft {
  const acp = provider?.acp;
  return {
    enabled: Boolean(acp),
    command: acp?.command ?? "",
    args: (acp?.args ?? ["acp"]).join(" "),
    modelId: acp?.modelId ?? "",
  };
}

/** `acp --flag "two words"` → `["acp", "--flag", "two words"]`. */
export function parseArgs(input: string): string[] {
  const out: string[] = [];
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(input))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export type AcpDraftProblem = "emptyCommand" | "unparsedArgs";

export function validateAcpDraft(draft: AcpDraft): AcpDraftProblem | null {
  if (!draft.enabled) return null;
  if (draft.command.trim() === "") return "emptyCommand";
  // Text that yields no argument at all is almost always a stray quote left
  // over from mid-typing, which would silently drop a flag.
  if (draft.args.trim() !== "" && parseArgs(draft.args).length === 0) return "unparsedArgs";
  return null;
}

export function acpConfigFrom(draft: AcpDraft): AcpAgentConfigLike | null {
  if (!draft.enabled || draft.command.trim() === "") return null;
  const modelId = draft.modelId.trim();
  return {
    command: draft.command.trim(),
    args: parseArgs(draft.args),
    ...(modelId ? { modelId } : {}),
  };
}

type Props = {
  draft: AcpDraft;
  onChange: (next: AcpDraft) => void;
  /** Lets the dialog refuse to save an unusable command. */
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
        <label className="field-label">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          {t("settings.acpEnable")}
        </label>
        {draft.enabled ? (
          <select
            className="field-input"
            value={presetId}
            onChange={(event) => {
              const preset = PRESETS.find((p) => p.id === event.target.value);
              setPresetId(event.target.value);
              if (preset) onChange({ ...draft, command: preset.command, args: preset.args });
            }}
          >
            <option value="">{t("settings.acpChoosePreset")}</option>
            {PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {draft.enabled ? (
        <>
          <p className="field-help">{t("settings.acpExplanation")}</p>
          <Field label={t("settings.acpCommand")}>
            <Input
              value={draft.command}
              placeholder="opencode"
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field label={t("settings.acpArgs")}>
            <Input
              value={draft.args}
              placeholder="acp"
              onChange={(event) => onChange({ ...draft, args: event.target.value })}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field label={t("settings.acpModel")}>
            <Input
              value={draft.modelId}
              placeholder={t("settings.acpModelPlaceholder")}
              onChange={(event) => onChange({ ...draft, modelId: event.target.value })}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          {problem === "emptyCommand" ? (
            <p className="field-warning" role="status">
              {t("settings.acpCommandRequired")}
            </p>
          ) : null}
          {problem === "unparsedArgs" ? (
            <p className="field-warning" role="status">
              {t("settings.acpArgsUnparsed")}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
