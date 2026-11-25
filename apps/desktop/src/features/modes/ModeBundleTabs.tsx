/**
 * The three tabs of one mode's settings (issue #2544).
 *
 * These cards render in the existing Settings content area, without a nested
 * modal, drawer, or sidebar.
 *
 * Model and thinking controls appear only under the role they belong to: the
 * mode itself follows the session model and has no model setting. A role's own
 * pin, its ordered fallbacks and each fallback's thinking level are its own
 * file's business, and this tab is where that file is edited.
 *
 * The skills tab is read-only except for one switch per skill: the issue gives
 * the page no create, import, edit or delete there. The user drops a skill
 * folder into the mode directory themselves and the host validates it.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_THINKING_LEVELS,
  imageGenerationBindings,
  isSubagentMutatingTool,
  type ModeSkillsResult,
  type SubagentThinkingLevel,
} from "@pi-desktop/shared";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  HelpIcon,
  Input,
  SettingsToggle,
  Textarea,
} from "../../components/ui";
import { SettingsCard, SettingsRow } from "../settings/primitives";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SubagentModelPicker } from "../../components/settings/SubagentModelPicker";
import {
  groupSubagentModelChoices,
  subagentModelChoices,
  subagentModelOrphanPin,
  subagentModelSelectValue,
} from "../../components/settings/subagent-models";
import { useAppStore } from "../../stores/app-store";
import {
  addRoleReference,
  bundleList,
  bundleScalar,
  includeGlobalSubagents,
  modeRoleRows,
  setBundleList,
  setBundleScalar,
  type ModeBundleDraft,
  type ModeRoleRow,
} from "./mode-bundle-model";
import {
  parseRoleDocument,
  serializeRoleDocument,
  toggleRoleTool,
  type RoleDocument,
} from "./mode-role-document";

/**
 * Configured models a role may pin.
 *
 * The list is the one Settings → Subagents offers, built from the same helper,
 * so a pin written here resolves exactly like a pin written there.
 */
function useRoleModelChoices() {
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  const providerModels = useAppStore((state) => state.providerModels);
  const images = useMemo(
    () => imageGenerationBindings(settings?.imageGenerationModels, settings?.imageGeneration),
    [settings?.imageGenerationModels, settings?.imageGeneration],
  );
  return useMemo(
    () => subagentModelChoices(providers, images, providerModels),
    [providers, images, providerModels],
  );
}

/* --- Mode tab ------------------------------------------------------------- */

/**
 * The mode's own map and prompt.
 *
 * The map is edited as text because it is where a mode's workflow is declared;
 * the prompt is a separate document in the directory, so the two are separate
 * fields and one save writes both. `includeGlobalSubagents` is a row because it
 * is the only mode-level decision the issue gives the page.
 */
export function ModeTab({
  draft,
  setDraft,
  promptFile,
  disabled,
}: {
  draft: ModeBundleDraft;
  setDraft: (next: ModeBundleDraft) => void;
  promptFile: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const includeGlobals = includeGlobalSubagents(draft.source);
  return (
    <>
      <SettingsCard title={t("modes.settings.tabMode")}>
        <SettingsRow
          title={t("modes.settings.includeGlobalSubagents")}
        >
          <SettingsToggle
            checked={includeGlobals}
            label={t("modes.settings.includeGlobalSubagents")}
            disabled={disabled}
            onChange={() =>
              setDraft({
                ...draft,
                source: setBundleScalar(draft.source, "includeGlobalSubagents", String(!includeGlobals)),
              })
            }
          />
        </SettingsRow>
        <div className="modes-settings-tab-field">
          <Field label={t("modes.settings.modeMap")}>
            <Textarea
              className="modes-settings-source"
              value={draft.source}
              aria-label={t("modes.settings.modeMap")}
              disabled={disabled}
              onChange={(event) => setDraft({ ...draft, source: event.target.value })}
            />
          </Field>
        </div>
      </SettingsCard>
      <SettingsCard title={t("modes.settings.promptTitle")} caption={promptFile}>
        <div className="modes-settings-tab-field">
          <Textarea
            className="modes-settings-source"
            value={draft.prompt}
            aria-label={t("modes.settings.promptTitle")}
            disabled={disabled}
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          />
        </div>
      </SettingsCard>
    </>
  );
}

/* --- Subagents tab -------------------------------------------------------- */

/**
 * The mode's private roles.
 *
 * A role is a document, so the tab shows one row per declared reference and one
 * editor for the selected row. A role that pins no model inherits the session
 * model; one that pins a model also carries its own thinking level, and each
 * ordered fallback may have a different thinking level.
 */
export function SubagentsTab({
  draft,
  setDraft,
  selected,
  onSelect,
  disabled,
}: {
  draft: ModeBundleDraft;
  setDraft: (next: ModeBundleDraft) => void;
  selected: string | null;
  onSelect: (reference: string | null) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const rows = modeRoleRows(draft.source, draft.agents);
  const row = rows.find((candidate) => candidate.reference === selected) ?? null;

  const write = (reference: string, source: string) =>
    setDraft({ ...draft, agents: { ...draft.agents, [reference]: source } });

  const addRole = () => {
    const reference = addRoleReference(bundleList(draft.source, "subagents"), "role");
    const declared = [...bundleList(draft.source, "subagents"), reference];
    setDraft({
      ...draft,
      agents: { ...draft.agents, [reference]: newRoleDocument(reference, t("modes.settings.roleBodyPlaceholder")) },
      source: setBundleList(draft.source, "subagents", declared),
    });
    onSelect(reference);
  };

  const removeRole = () => {
    if (!row) return;
    const remaining = rows
      .filter((candidate) => candidate.reference !== row.reference)
      .map((candidate) => candidate.reference);
    const agents = { ...draft.agents };
    delete agents[row.reference];
    setDraft({ ...draft, agents, source: setBundleList(draft.source, "subagents", remaining) });
    onSelect(remaining[0] ?? null);
  };

  return (
    <>
      <SettingsCard
        title={t("modes.settings.rolesTitle")}
        action={
          <Button size="sm" variant="ghost" disabled={disabled} onClick={addRole}>
            {t("modes.settings.addRole")}
          </Button>
        }
      >
        <div className="modes-settings-list" role="list" aria-label={t("modes.settings.rolesTitle")}>
          {rows.map((role) => (
            <div role="listitem" key={role.reference}>
              <button
                type="button"
                className="modes-settings-row"
                aria-current={role.reference === selected || undefined}
                data-role-reference={role.reference}
                title={role.description || undefined}
                disabled={disabled}
                onClick={() => onSelect(role.reference)}
              >
                <span className="modes-settings-row-copy">
                  <span>{role.name}</span>
                  <span className="modes-settings-row-id">{role.reference}</span>
                </span>
                <span className="modes-settings-row-badges">
                  <Badge tone={role.inheritsModel ? "neutral" : "success"}>
                    {t(role.inheritsModel ? "modes.settings.roleInheritsModel" : "modes.settings.rolePinnedModel")}
                  </Badge>
                  {role.thinkingLevel ? <Badge>{role.thinkingLevel}</Badge> : null}
                </span>
              </button>
            </div>
          ))}
        </div>
        {rows.length === 0 ? <p className="modes-settings-hint">{t("modes.settings.rolesEmpty")}</p> : null}
      </SettingsCard>
      {row ? (
        <RoleEditor
          key={row.reference}
          row={row}
          disabled={disabled}
          onChange={(source) => write(row.reference, source)}
          onRemove={removeRole}
        />
      ) : null}
    </>
  );
}

/** A role document that loads: a handle, and instructions to the delegate. */
function newRoleDocument(reference: string, body: string): string {
  const segment = (reference.split("/").pop() ?? "role").split(".")[0] ?? "role";
  const name =
    segment.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "role";
  return serializeRoleDocument({ ...parseRoleDocument(""), name, description: "", body });
}

/** One role's fields, sharing the model and thinking controls with Subagents. */
function RoleEditor({
  row,
  disabled,
  onChange,
  onRemove,
}: {
  row: ModeRoleRow;
  disabled: boolean;
  onChange: (source: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const choices = useRoleModelChoices();
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const role = parseRoleDocument(row.source);
  const write = (next: RoleDocument) => onChange(serializeRoleDocument(next));
  const orphan = subagentModelOrphanPin(role.model, choices);

  return (
    <SettingsCard title={row.name} caption={row.reference}>
      <div className="modes-settings-tab-fields">
        <div className="ext-field-pair">
          <Field label={t("extensions.subagents.name")}>
            <Input
              value={role.name}
              disabled={disabled}
              onChange={(event) => write({ ...role, name: event.target.value })}
            />
          </Field>
          <Field label={t("extensions.subagents.description")}>
            <Input
              value={role.description}
              disabled={disabled}
              onChange={(event) => write({ ...role, description: event.target.value })}
            />
          </Field>
        </div>

        <div className="ext-field-group">
          <div className="ext-field-label">
            {t("extensions.subagents.tools")}
            <HelpIcon
              label={t(
                role.inheritTools
                  ? "extensions.subagents.toolsInheritHint"
                  : role.tools.some(isSubagentMutatingTool)
                    ? "extensions.subagents.mutatingHint"
                    : "extensions.subagents.toolsHint",
              )}
            />
          </div>
          <div className="ext-tool-pick" role="group" aria-label={t("extensions.subagents.tools")}>
            <Checkbox
              label={t("extensions.subagents.toolsInherit")}
              checked={role.inheritTools}
              disabled={disabled}
              onChange={(event) => write({ ...role, inheritTools: event.target.checked })}
            />
            {SUBAGENT_ASSIGNABLE_TOOLS.map((tool) => (
              <Checkbox
                key={tool}
                label={<code>{tool}</code>}
                checked={role.tools.includes(tool)}
                disabled={disabled}
                onChange={(event) =>
                  write({ ...role, tools: toggleRoleTool(role.tools, tool, event.target.checked) })
                }
              />
            ))}
          </div>
        </div>

        <div className="ext-field-pair">
          <Field
            label={t("extensions.subagents.model")}
            hint={
              choices.length > 0
                ? t("extensions.subagents.modelHint")
                : t("extensions.subagents.modelPickEmpty")
            }
          >
            <SubagentModelPicker
              value={subagentModelSelectValue(role.model, choices)}
              groups={groups}
              orphanPin={orphan}
              disabled={disabled || choices.length === 0}
              onChange={(next) => write({ ...role, model: next })}
            />
          </Field>
          <Field label={t("extensions.subagents.thinking")} hint={t("extensions.subagents.thinkingHint")}>
            <SettingsMenuSelect
              fullWidth
              label={t("extensions.subagents.thinking")}
              value={role.thinkingLevel}
              disabled={disabled}
              onChange={(id) => write({ ...role, thinkingLevel: id as SubagentThinkingLevel | "" })}
              options={thinkingOptions(t)}
            />
          </Field>
        </div>

        <Field
          label={t("extensions.subagents.fallbackModels")}
          hint={t("extensions.subagents.fallbackModelsHint")}
        >
          <ol className="modes-settings-fallbacks">
            {role.fallbacks.map((fallback, index) => (
              <li key={`${index}:${fallback.model}`} className="modes-settings-fallback">
                <SubagentModelPicker
                  value={subagentModelSelectValue(fallback.model, choices)}
                  groups={groups}
                  orphanPin={subagentModelOrphanPin(fallback.model, choices)}
                  allowInherit={false}
                  disabled={disabled || choices.length === 0}
                  label={t("extensions.subagents.fallbackAdd")}
                  emptyLabel={t("extensions.subagents.fallbackAdd")}
                  onChange={(pin) =>
                    write({
                      ...role,
                      fallbacks: role.fallbacks.map((entry, position) =>
                        position === index ? { ...entry, model: pin } : entry,
                      ),
                    })
                  }
                />
                <SettingsMenuSelect
                  fullWidth
                  label={t("extensions.subagents.thinking")}
                  value={fallback.thinkingLevel}
                  disabled={disabled}
                  onChange={(id) =>
                    write({
                      ...role,
                      fallbacks: role.fallbacks.map((entry, position) =>
                        position === index
                          ? { ...entry, thinkingLevel: id as SubagentThinkingLevel | "" }
                          : entry,
                      ),
                    })
                  }
                  options={thinkingOptions(t)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  aria-label={t("extensions.subagents.fallbackRemove", { model: fallback.model })}
                  onClick={() =>
                    write({
                      ...role,
                      fallbacks: role.fallbacks.filter((_, position) => position !== index),
                    })
                  }
                >
                  ×
                </Button>
              </li>
            ))}
          </ol>
          {choices.length > 0 ? (
            <SubagentModelPicker
              value=""
              groups={groups}
              orphanPin={null}
              allowInherit={false}
              disabled={disabled}
              label={t("extensions.subagents.fallbackAdd")}
              emptyLabel={t("extensions.subagents.fallbackAdd")}
              onChange={(pin) =>
                write({ ...role, fallbacks: [...role.fallbacks, { model: pin, thinkingLevel: "" }] })
              }
            />
          ) : null}
        </Field>

        <Field label={t("extensions.subagents.body")}>
          <Textarea
            className="ext-skill-body"
            value={role.body}
            rows={10}
            spellCheck={false}
            disabled={disabled}
            aria-label={t("extensions.subagents.body")}
            onChange={(event) => write({ ...role, body: event.target.value })}
          />
        </Field>

        <div className="modes-settings-tab-actions">
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
            {t("modes.settings.removeRole")}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function thinkingOptions(t: (key: string) => string) {
  return [
    { id: "", label: t("extensions.subagents.thinkingInherit") },
    { id: "omit", label: t("extensions.subagents.thinkingOmit") },
    ...SUBAGENT_THINKING_LEVELS.filter((level) => level !== "omit").map((level) => ({
      id: level,
      label: level,
    })),
  ];
}

/* --- Skills tab ----------------------------------------------------------- */

/** The map's declared prompt reference, for the Mode tab's caption. */
export function promptReference(source: string): string {
  return bundleScalar(source, "promptFile") ?? "";
}

/**
 * The mode's own `skills/` folder: where it is, a way to open it, and one
 * switch per discovered skill.
 *
 * Opening creates the folder when it does not exist yet, because the user's
 * next step is to drop a skill in. The switch writes `disabledSkills` on this
 * mode alone; nothing here touches a `SKILL.md` or another mode's list.
 */
export function SkillsTab({
  state,
  busy,
  onOpen,
  onToggle,
}: {
  state: ModeSkillsResult | null;
  busy: boolean;
  onOpen: () => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsCard
      title={t("modes.settings.skillsTitle")}
      action={
        <Button size="sm" variant="secondary" disabled={busy} onClick={onOpen}>
          {t("modes.settings.openSkillsDirectory")}
        </Button>
      }
    >
      <div className="modes-settings-directory">
        <span className="settings-row-title">{t("modes.settings.skillsDirectory")}</span>
        <span className="modes-settings-path" data-testid="modes-skills-directory">
          {state?.directory ?? ""}
        </span>
      </div>
      <div className="modes-settings-list" role="list" aria-label={t("modes.settings.skillsTitle")}>
        {(state?.skills ?? []).map((skill) => (
          <div role="listitem" key={skill.id}>
            <SettingsRow title={skill.name} detail={<code>{`/skill:${skill.id}`}</code>}>
              <SettingsToggle
                checked={skill.enabled}
                label={t("settings.enableCapability", { name: skill.name })}
                disabled={busy}
                onChange={() => onToggle(skill.id, !skill.enabled)}
              />
            </SettingsRow>
          </div>
        ))}
      </div>
      {state?.exists && state.skills.length === 0 ? (
        <p className="modes-settings-hint">{t("modes.settings.skillsEmpty")}</p>
      ) : null}
    </SettingsCard>
  );
}
