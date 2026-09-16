import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_SUBAGENT_TOOLS,
  GLOBAL_SCOPE,
  MAX_SUBAGENT_MAX_TOKENS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_INHERIT_TOKEN,
  SUBAGENT_PRESETS,
  SUBAGENT_THINKING_LEVELS,
  findSubagentPreset,
  isSubagentAssignableTool,
  isSubagentMutatingTool,
  resolveScope,
  type ActivationScope,
  type SubagentDefinition,
  type SubagentPreset,
  type SubagentThinkingLevel,
  type UserSubagentRecord,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { Button, Field, Input, Textarea, TooltipButton, cx } from "../ui";
import { IconChevronRight, IconFolderOpen, IconX } from "../icons";
import {
  groupSubagentModelChoices,
  subagentModelChoices,
  subagentModelOrphanPin,
  subagentModelPinParts,
  subagentModelSelectValue,
} from "./subagent-models";
import { SubagentModelPicker } from "./SubagentModelPicker";
import { SubagentFallbackModels } from "./SubagentFallbackModels";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

/** Hard cap host-core enforces on a definition document. */
export const MAX_SUBAGENT_BYTES = 32 * 1024;

export type SubagentDraft = {
  id: string;
  name: string;
  description: string;
  /** Assignable extras. May be empty when `inheritTools` is on. */
  tools: string[];
  /** Frontmatter `tools: inherit` — union the parent session catalog. */
  inheritTools: boolean;
  /** `<provider>/<model>`, or empty for "same model as this session". */
  model: string;
  fallbackModels: string[];
  /** Empty means "whatever the session uses". */
  thinkingLevel: SubagentThinkingLevel | "";
  /**
   * Output-token cap for one delegate response. `0` means "follow the model's
   * published limit", which is what a definition without `maxTokens` gets.
   */
  maxTokens: number;
  body: string;
  enabled: boolean;
  scope: ActivationScope;
};

/** Split a stored tools list into the inherit flag and assignable extras. */
export function splitSubagentToolGrant(tools: readonly string[]): {
  inheritTools: boolean;
  tools: string[];
} {
  const inheritTools = tools.some((name) => name === SUBAGENT_INHERIT_TOKEN);
  const assignable = tools.filter((name) => isSubagentAssignableTool(name));
  return {
    inheritTools,
    tools:
      assignable.length > 0 || inheritTools
        ? assignable
        : [...DEFAULT_SUBAGENT_TOOLS],
  };
}

/** Frontmatter `tools` list written on save. */
export function mergeSubagentToolGrant(
  inheritTools: boolean,
  tools: readonly string[],
): string[] {
  return inheritTools ? [SUBAGENT_INHERIT_TOKEN, ...tools] : [...tools];
}

/**
 * The starter document. A subagent's body is its whole system prompt, so the
 * template is written as instructions to the delegate rather than as notes about
 * it — the difference between the two is the most common way a definition ends
 * up not working.
 */
export function subagentTemplate(name: string): string {
  const title = name.trim() || "this delegate";
  return `You are ${title}, working on one task for another agent.

## What to do
Describe the job in the imperative: what to look at, in what order, when to stop.

## What to report back
Say exactly what the answer should look like — the parent agent only sees your
final message, not your steps.

## Limits
Anything you must not do.
`;
}

/** A "blank" starter so users who ignore the preset chips are not stuck. */
export const BLANK_SUBAGENT_PRESET_ID = "" as const;

/**
 * Catalog keys for each built-in preset. Hyphenated ids (`code-reviewer`)
 * cannot be turned into keys by capitalizing the first letter — the hyphen
 * stays in the middle of the key, which is not in the catalog.
 */
export const SUBAGENT_PRESET_COPY = {
  explorer: { name: "presetExplorerName", desc: "presetExplorerDesc" },
  "code-reviewer": { name: "presetReviewerName", desc: "presetReviewerDesc" },
  "test-runner": { name: "presetTestRunnerName", desc: "presetTestRunnerDesc" },
  fixer: { name: "presetFixerName", desc: "presetFixerDesc" },
  "ui-designer": { name: "presetUiDesignerName", desc: "presetUiDesignerDesc" },
} as const satisfies Record<SubagentPreset["id"], { name: string; desc: string }>;

/** Full i18n path for a preset chip, or null when `id` is blank / unknown. */
export function subagentPresetCopyKey(
  id: string,
  kind: "name" | "desc",
): string | null {
  if (!Object.hasOwn(SUBAGENT_PRESET_COPY, id)) return null;
  const entry = SUBAGENT_PRESET_COPY[id as keyof typeof SUBAGENT_PRESET_COPY];
  return `extensions.subagents.${entry[kind]}`;
}

export function emptySubagentDraft(): SubagentDraft {
  return {
    id: "",
    name: "",
    description: "",
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    inheritTools: false,
    model: "",
    fallbackModels: [],
    thinkingLevel: "",
    maxTokens: 0,
    body: "",
    enabled: true,
    scope: GLOBAL_SCOPE,
  };
}

export function draftFromRecord(record: UserSubagentRecord, body: string): SubagentDraft {
  const grant = splitSubagentToolGrant(record.tools);
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? "",
    tools: grant.tools,
    inheritTools: grant.inheritTools,
    model: record.model ?? "",
    fallbackModels: [...(record.fallbackModels ?? [])],
    thinkingLevel: record.thinkingLevel ?? "",
    maxTokens: record.maxTokens ?? 0,
    body,
    enabled: record.enabled,
    scope: resolveScope(record.scope),
  };
}

/** Prefill the create sheet from a shipped definition (Copy as mine). */
export function draftFromDefinition(definition: SubagentDefinition): SubagentDraft {
  const preset = findSubagentPreset(definition.name);
  const grant = splitSubagentToolGrant(
    definition.inheritTools
      ? [SUBAGENT_INHERIT_TOKEN, ...definition.tools]
      : definition.tools,
  );
  return {
    ...emptySubagentDraft(),
    name: preset?.name ?? definition.name,
    description: definition.description,
    tools: grant.tools,
    inheritTools: grant.inheritTools,
    model: definition.model
      ? `${definition.model.providerId}/${definition.model.modelId}`
      : "",
    fallbackModels: (definition.fallbackModels ?? []).map((pin) => `${pin.providerId}/${pin.modelId}`),
    thinkingLevel: definition.thinkingLevel ?? "",
    maxTokens: definition.maxTokens ?? 0,
    body: definition.prompt,
  };
}

/** Mirror of host-core's `normalize_name`, so the handle shown is the one stored. */
export function subagentSlug(value: string): string {
  let slug = "";
  let lastDash = false;
  for (const char of value.trim().toLocaleLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      slug += char;
      lastDash = false;
    } else if (slug && !lastDash) {
      slug += "-";
      lastDash = true;
    }
  }
  return slug.slice(0, 40).replace(/-+$/, "");
}

/**
 * Apply a built-in preset to a draft. Tool grants are replaced wholesale so a
 * preset that drops `Bash` truly drops it. Body and description are
 * overwritten — these are the values that make the preset worth picking.
 * Inherit is cleared: presets are the built-in delegates, not parent-catalog
 * workers.
 */
export function applySubagentPreset(draft: SubagentDraft, preset: SubagentPreset): SubagentDraft {
  return {
    ...draft,
    name: preset.name,
    description: preset.description,
    tools: [...preset.tools],
    inheritTools: false,
    body: preset.body,
  };
}

/** Clear the template-owned fields while preserving the user's model choices. */
export function resetSubagentTemplate(draft: SubagentDraft): SubagentDraft {
  return {
    ...draft,
    name: "",
    description: "",
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    inheritTools: false,
    body: "",
  };
}

/** Returns an i18n key for the first problem, or null when the draft can save. */
export function subagentDraftError(draft: SubagentDraft): string | null {
  if (!draft.name.trim()) return "extensions.subagents.errorName";
  if (!subagentSlug(draft.name)) return "extensions.subagents.errorSlug";
  if (!draft.description.trim()) return "extensions.subagents.errorDescription";
  if (!draft.inheritTools && draft.tools.length === 0) {
    return "extensions.subagents.errorTools";
  }
  // `provider/model` is the only shape the runtime can resolve; a bare model id
  // has no provider to look up, so it would be dropped with a diagnostic nobody
  // reads. Only the slash is structural: the provider half is matched by a
  // normalized alias, and a custom endpoint's display name may contain spaces —
  // the picker offers those, so rejecting them here would make a selectable
  // option impossible to save. This shares the picker's own splitter so the two
  // can never disagree.
  if ([draft.model, ...draft.fallbackModels].some((pin) => pin.trim() && !subagentModelPinParts(pin.trim()))) {
    return "extensions.subagents.errorModel";
  }
  // Cleared (`0`) is a valid state that means "no cap of our own", so only a
  // value outside the accepted range is an error. The field only produces
  // integers, so a fraction cannot reach here from the UI — the check keeps
  // the draft honest anyway.
  if (
    !Number.isInteger(draft.maxTokens) ||
    draft.maxTokens < 0 ||
    draft.maxTokens > MAX_SUBAGENT_MAX_TOKENS
  ) {
    return "extensions.subagents.errorMaxTokens";
  }
  if (!draft.body.trim()) return "extensions.subagents.errorBody";
  if (new TextEncoder().encode(draft.body).length > MAX_SUBAGENT_BYTES) {
    return "extensions.subagents.errorTooBig";
  }
  return null;
}

/**
 * One subagent preset shown as a compact name chip. Selecting it replaces the
 * draft's name, description, tools and body; the model and scope
 * are left alone so the user's other choices survive a reroll.
 */
function PresetChip({
  selected,
  onSelect,
  nameLabel,
}: {
  selected: boolean;
  onSelect: () => void;
  nameLabel: string;
}) {
  return (
    <button
      type="button"
      className={cx("ext-preset-chip", selected && "is-selected")}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="ext-preset-chip-name">{nameLabel}</span>
    </button>
  );
}

/**
 * The "start from template" chip row shown above the form when creating a new
 * subagent. A blank chip sits alongside the built-ins so users who want a
 * clean slate are not forced into a preset. The row is hidden entirely on
 * edit — a draft that has already been saved owns its body.
 */
function PresetPicker({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (presetId: string) => void;
}) {
  const { t } = useTranslation();
  const blankSelected = selectedId === BLANK_SUBAGENT_PRESET_ID;
  const descKey =
    selectedId === BLANK_SUBAGENT_PRESET_ID
      ? "extensions.subagents.presetBlankDesc"
      : selectedId
        ? subagentPresetCopyKey(selectedId, "desc")
        : null;
  return (
    <div className="ext-field-group">
      <div className="ext-field-label">{t("extensions.subagents.presetLabel")}</div>
      <div
        className="ext-preset-pick"
        role="group"
        aria-label={t("extensions.subagents.presetLabel")}
        aria-describedby={descKey ? "subagent-preset-desc" : undefined}
      >
        {SUBAGENT_PRESETS.map((preset) => {
          const nameKey = subagentPresetCopyKey(preset.id, "name");
          return (
            <PresetChip
              key={preset.id}
              selected={selectedId === preset.id}
              onSelect={() => onSelect(preset.id)}
              nameLabel={nameKey ? t(nameKey) : preset.name}
            />
          );
        })}
        <PresetChip
          selected={blankSelected}
          onSelect={() => onSelect(BLANK_SUBAGENT_PRESET_ID)}
          nameLabel={t("extensions.subagents.presetBlank")}
        />
      </div>
      {descKey ? (
        <p id="subagent-preset-desc" className="ext-preset-desc">
          {t(descKey)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Subagents are global-only (D202), so there is no level to choose: this states
 * where the document lands and leaves only the active decision.
 */
function ManagementScope({
  draft,
  setDraft,
}: {
  draft: SubagentDraft;
  setDraft: (next: SubagentDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="agent-mcp-scope">
      <div className="agent-mcp-scope-copy">
        <span className="agent-mcp-scope-label">{t("settings.globalScope")}</span>
        <span className="agent-mcp-scope-hint">{t("settings.subagentsOnlyGlobal")}</span>
      </div>
      <button
        type="button"
        className={cx("settings-toggle", draft.enabled && "on")}
        role="switch"
        aria-checked={draft.enabled}
        aria-label={t("settings.enableCapability", { name: draft.name || draft.id })}
        onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
      >
        <span className="settings-toggle-thumb" />
      </button>
    </div>
  );
}

/**
 * Model and thinking controls for a subagent definition.
 *
 * The model list offers only models the user already configured, so the value
 * saved is always resolvable in Settings; there is no free-text escape hatch.
 * When no provider offers a runnable model the field explains that and links to
 * Models instead of accepting a hand-typed id the runtime could not resolve.
 */
function ModelField({
  draft,
  setDraft,
  modelChoices,
  modelGroups,
  orphanModel,
}: {
  draft: SubagentDraft;
  setDraft: (next: SubagentDraft) => void;
  modelChoices: ReturnType<typeof subagentModelChoices>;
  modelGroups: ReturnType<typeof groupSubagentModelChoices>;
  orphanModel: string | null;
}) {
  const { t } = useTranslation();
  const modelValue = subagentModelSelectValue(draft.model, modelChoices);

  return (
    <>
      <div className="ext-field-pair">
        <Field
          label={t("extensions.subagents.model")}
          hint={
            modelChoices.length > 0
              ? t("extensions.subagents.modelHint")
              : t("extensions.subagents.modelPickEmpty")
          }
        >
          {modelChoices.length === 0 ? (
            <div className="ext-field-empty">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const store = useAppStore.getState();
                  store.setSettingsTab("agent");
                }}
              >
                {t("extensions.subagents.modelPickEmptyAction")}
              </Button>
            </div>
          ) : (
            <SubagentModelPicker
              value={modelValue}
              groups={modelGroups}
              orphanPin={orphanModel}
              onChange={(next) => setDraft({ ...draft, model: next })}
            />
          )}
        </Field>
        <Field
          label={t("extensions.subagents.thinking")}
          hint={t("extensions.subagents.thinkingHint")}
        >
          <SettingsMenuSelect
            fullWidth
            label={t("extensions.subagents.thinking")}
            value={draft.thinkingLevel}
            onChange={(id) =>
              setDraft({
                ...draft,
                thinkingLevel: id as SubagentThinkingLevel | "",
              })
            }
            options={[
              { id: "", label: t("extensions.subagents.thinkingInherit") },
              { id: "omit", label: t("extensions.subagents.thinkingOmit") },
              ...SUBAGENT_THINKING_LEVELS.filter((level) => level !== "omit").map(
                (level) => ({ id: level, label: level }),
              ),
            ]}
          />
        </Field>
      </div>
      <SubagentFallbackModels
        primary={draft.model}
        values={draft.fallbackModels}
        choices={modelChoices}
        onChange={(fallbackModels) => setDraft({ ...draft, fallbackModels })}
      />
    </>
  );
}

/** Model, thinking and scope — secondary on create, open on edit. */
function AdvancedFields({
  open,
  onToggle,
  draft,
  setDraft,
  modelChoices,
  modelGroups,
  orphanModel,
}: {
  open: boolean;
  onToggle: () => void;
  draft: SubagentDraft;
  setDraft: (next: SubagentDraft) => void;
  modelChoices: ReturnType<typeof subagentModelChoices>;
  modelGroups: ReturnType<typeof groupSubagentModelChoices>;
  orphanModel: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="ext-sheet-advanced">
      <button
        type="button"
        className="ext-sheet-advanced-toggle"
        aria-expanded={open}
        aria-controls="subagent-sheet-advanced"
        onClick={onToggle}
      >
        <IconChevronRight size={12} aria-hidden />
        {t("settings.advanced")}
      </button>
      <div id="subagent-sheet-advanced" className="ext-sheet-advanced-body" hidden={!open}>
        <ModelField
          draft={draft}
          setDraft={setDraft}
          modelChoices={modelChoices}
          modelGroups={modelGroups}
          orphanModel={orphanModel}
        />
        <Field
          label={t("extensions.subagents.maxTokens")}
          hint={t("extensions.subagents.maxTokensHint", {
            max: MAX_SUBAGENT_MAX_TOKENS.toLocaleString(),
          })}
        >
          <Input
            type="number"
            min={1}
            max={MAX_SUBAGENT_MAX_TOKENS}
            placeholder={t("extensions.subagents.maxTokensDefault")}
            value={draft.maxTokens > 0 ? String(draft.maxTokens) : ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                maxTokens: Number.parseInt(event.target.value, 10) || 0,
              })
            }
          />
        </Field>
        <div className="ext-field-group">
          <div className="ext-field-label">{t("settings.scope")}</div>
          <ManagementScope draft={draft} setDraft={setDraft} />
        </div>
      </div>
    </div>
  );
}

/**
 * Create/edit sheet for one subagent definition.
 *
 * The tool grant sits above the prompt because it is the only field with a
 * safety consequence: a delegate that declares `Bash`, `Edit` or `Write` can
 * change the workspace on its own (ADR 0062), and a checkbox group makes that
 * choice explicit instead of hiding it in frontmatter the user has to remember
 * to write.
 */
export function SubagentEditorSheet({
  draft,
  setDraft,
  editing,
  saving,
  initialPresetId,
  onClose,
  onSave,
  onReveal,
}: {
  draft: SubagentDraft;
  setDraft: (next: SubagentDraft) => void;
  editing: UserSubagentRecord | null;
  saving: boolean;
  /** Template chip to select on create, e.g. after Copy as mine. */
  initialPresetId?: string;
  onClose: () => void;
  onSave: () => void;
  onReveal?: () => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const copiedPreset = Boolean(initialPresetId && findSubagentPreset(initialPresetId));
  const [nameTouched, setNameTouched] = useState(!!editing || copiedPreset);
  const [presetId, setPresetId] = useState<string | null>(
    copiedPreset && initialPresetId ? initialPresetId : BLANK_SUBAGENT_PRESET_ID,
  );
  const [advancedOpen, setAdvancedOpen] = useState(!!editing);
  const errorKey = subagentDraftError(draft);
  const pristine = !editing && !draft.name.trim() && !draft.description.trim();
  const bytes = new TextEncoder().encode(draft.body).length;
  const slug = draft.id || subagentSlug(draft.name);
  const modelChoices = useMemo(() => subagentModelChoices(providers), [providers]);
  const modelGroups = useMemo(
    () => groupSubagentModelChoices(modelChoices),
    [modelChoices],
  );
  const orphanModel = subagentModelOrphanPin(draft.model, modelChoices);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const set = <K extends keyof SubagentDraft>(key: K, value: SubagentDraft[K]) =>
    setDraft({ ...draft, [key]: value });

  // Naming a new delegate seeds the body once, so the editor is never a blank
  // page but never overwrites something the user has started writing either.
  const setName = (value: string) => {
    const next: SubagentDraft = { ...draft, name: value };
    if (!nameTouched && !editing && !draft.body.trim()) {
      next.body = subagentTemplate(value);
    }
    setDraft(next);
  };

  const toggleTool = (tool: string, on: boolean) =>
    set(
      "tools",
      on
        ? // Keep the canonical order, so the document reads the same however the
          // boxes were clicked.
          SUBAGENT_ASSIGNABLE_TOOLS.filter(
            (candidate) => candidate === tool || draft.tools.includes(candidate),
          )
        : draft.tools.filter((candidate) => candidate !== tool),
    );

  const applyPreset = (nextId: string) => {
    setPresetId(nextId);
    if (!nextId || nextId === BLANK_SUBAGENT_PRESET_ID) {
      setDraft(resetSubagentTemplate(draft));
      setNameTouched(false);
      return;
    }
    const preset = SUBAGENT_PRESETS.find((candidate) => candidate.id === nextId);
    if (!preset) return;
    setDraft(applySubagentPreset(draft, preset));
    setNameTouched(true);
  };

  return (
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
        aria-labelledby="subagent-sheet-title"
      >
        <div className="ext-sheet-head">
          <div>
            <h3 id="subagent-sheet-title" className="ext-sheet-title">
              {editing
                ? t("extensions.subagents.editTitle")
                : t("extensions.subagents.addTitle")}
            </h3>
          </div>
          <TooltipButton
            type="button"
            className="ext-sheet-close"
            ariaLabel={t("common.close")}
            tooltip={t("common.close")}
            onClick={onClose}
          >
            <IconX size={14} />
          </TooltipButton>
        </div>

        <div className="ext-sheet-body">
          {!editing ? (
            <PresetPicker selectedId={presetId} onSelect={applyPreset} />
          ) : null}

          <Field
            label={t("extensions.subagents.name")}
            hint={slug ? t("extensions.subagents.slugHint", { id: slug }) : undefined}
          >
            <Input
              value={draft.name}
              autoFocus={!editing}
              placeholder={t("extensions.subagents.namePlaceholder")}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
            />
          </Field>

          <Field label={t("extensions.subagents.description")}>
            <Textarea
              value={draft.description}
              rows={2}
              placeholder={t("extensions.subagents.descriptionPlaceholder")}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>

          <div className="ext-field-group">
            <div className="ext-field-label">{t("extensions.subagents.tools")}</div>
            <div
              className="ext-tool-pick"
              role="group"
              aria-label={t("extensions.subagents.tools")}
            >
              <label
                className={cx("ext-tool-opt", draft.inheritTools && "is-on")}
              >
                <input
                  type="checkbox"
                  checked={draft.inheritTools}
                  onChange={(event) => set("inheritTools", event.target.checked)}
                />
                <span>{t("extensions.subagents.toolsInherit")}</span>
              </label>
              {SUBAGENT_ASSIGNABLE_TOOLS.map((tool) => (
                <label
                  key={tool}
                  className={cx(
                    "ext-tool-opt",
                    draft.tools.includes(tool) && "is-on",
                    isSubagentMutatingTool(tool) && "is-mutating",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={draft.tools.includes(tool)}
                    onChange={(event) => toggleTool(tool, event.target.checked)}
                  />
                  <code>{tool}</code>
                </label>
              ))}
            </div>
            {draft.inheritTools ? (
              <p className="ext-field-hint">{t("extensions.subagents.toolsInheritHint")}</p>
            ) : draft.tools.some(isSubagentMutatingTool) ? (
              <p className="ext-field-hint">{t("extensions.subagents.mutatingHint")}</p>
            ) : (
              <p className="ext-field-hint">{t("extensions.subagents.toolsHint")}</p>
            )}
          </div>

          <div className="ext-field-group">
            <div className="ext-field-label ext-field-label-row">
              <span>{t("extensions.subagents.body")}</span>
              <span
                className={
                  bytes > MAX_SUBAGENT_BYTES
                    ? "ext-byte-count is-over"
                    : bytes > MAX_SUBAGENT_BYTES * 0.8
                      ? "ext-byte-count is-near"
                      : "ext-byte-count"
                }
              >
                {t("extensions.subagents.bytes", {
                  used: Math.round(bytes / 1024),
                  max: Math.round(MAX_SUBAGENT_BYTES / 1024),
                })}
              </span>
            </div>
            <Textarea
              className="ext-skill-body"
              value={draft.body}
              rows={8}
              spellCheck={false}
              placeholder={subagentTemplate("")}
              aria-label={t("extensions.subagents.body")}
              onChange={(event) => set("body", event.target.value)}
            />
          </div>

          <AdvancedFields
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((current) => !current)}
            draft={draft}
            setDraft={setDraft}
            modelChoices={modelChoices}
            modelGroups={modelGroups}
            orphanModel={orphanModel}
          />
        </div>

        {errorKey && !pristine ? (
          <p id="subagent-sheet-error" className="ext-sheet-error" role="alert">
            {t(errorKey)}
          </p>
        ) : null}
        <div className="ext-sheet-actions">
          {editing && onReveal ? (
            <Button variant="ghost" onClick={onReveal}>
              <IconFolderOpen size={13} />
              {t("extensions.subagents.reveal")}
            </Button>
          ) : null}
          <div className="ext-sheet-actions-end">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={onSave}
              disabled={saving || !!errorKey}
              title={errorKey ? t(errorKey) : undefined}
            >
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
