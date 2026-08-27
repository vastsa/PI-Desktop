import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  resolveScope,
  type ActivationScope,
  type AgentCapabilityLevel,
  type UserSkillRecord,
} from "@pi-desktop/shared";
import { Button, Field, Input, Textarea, cx } from "../ui";
import { IconFolderOpen, IconX } from "../icons";

/** Hard cap host-core enforces on a skill document. */
export const MAX_SKILL_BYTES = 128 * 1024;

export type SkillDraft = {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  scope: ActivationScope;
};

/**
 * The starter document, written so the first thing the user sees is a skill that
 * would already work. An empty editor teaches nothing about the format; a
 * heading plus steps is the shape every good skill has.
 */
export function skillTemplate(name: string): string {
  const title = name.trim() || "New skill";
  return `# ${title}

## When to use this
Describe the situation that should make the model reach for this skill.

## Steps
1. ...
2. ...

## Notes
Anything the model would otherwise guess wrong.
`;
}

export function emptySkillDraft(): SkillDraft {
  return {
    id: "",
    name: "",
    description: "",
    body: "",
    enabled: true,
    scope: GLOBAL_SCOPE,
  };
}

export function draftFromSkill(record: UserSkillRecord, body: string): SkillDraft {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? "",
    body,
    enabled: record.enabled,
    scope: resolveScope(record.scope),
  };
}

/** Mirror of host-core's `slugify`, so the id shown matches the one stored. */
export function skillSlug(value: string): string {
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
  return slug.slice(0, 64).replace(/-+$/, "");
}

/** Returns an i18n key for the first problem, or null when the draft can save. */
export function skillDraftError(draft: SkillDraft): string | null {
  if (!draft.name.trim()) return "extensions.skills.errorName";
  if (!skillSlug(draft.name) && !draft.id) return "extensions.skills.errorSlug";
  if (!draft.description.trim()) return "extensions.skills.errorDescription";
  if (!draft.body.trim()) return "extensions.skills.errorBody";
  if (new TextEncoder().encode(draft.body).length > MAX_SKILL_BYTES) {
    return "extensions.skills.errorTooBig";
  }
  return null;
}

/**
 * Where the document will be written. Settings owns the level, so this states
 * it instead of offering a second, conflicting scope control; the only decision
 * left here is whether the skill is active.
 */
function ManagementScope({
  draft,
  setDraft,
  level,
  projectName,
}: {
  draft: SkillDraft;
  setDraft: (next: SkillDraft) => void;
  level: AgentCapabilityLevel;
  projectName?: string;
}) {
  const { t } = useTranslation();
  const label =
    level === "global"
      ? t("settings.globalScope")
      : t("settings.projectScope", { project: projectName || t("settings.currentProject") });
  return (
    <div className="agent-mcp-scope">
      <div className="agent-mcp-scope-copy">
        <span className="agent-mcp-scope-label">{label}</span>
        <span className="agent-mcp-scope-hint">
          {level === "global"
            ? t("settings.globalScopeDescription")
            : t("settings.projectScopeDescription")}
        </span>
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
 * Create/edit sheet for one user skill.
 *
 * The description field is required and sits above the body because it is the
 * only part the model reads before deciding to open the skill at all (D174) —
 * treating it as optional metadata would make a well-written skill invisible.
 */
export function SkillEditorSheet({
  draft,
  setDraft,
  editing,
  saving,
  level,
  projectName,
  onClose,
  onSave,
  onReveal,
}: {
  draft: SkillDraft;
  setDraft: (next: SkillDraft) => void;
  editing: UserSkillRecord | null;
  saving: boolean;
  level: AgentCapabilityLevel;
  projectName?: string;
  onClose: () => void;
  onSave: () => void;
  onReveal?: () => void;
}) {
  const { t } = useTranslation();
  const [nameTouched, setNameTouched] = useState(!!editing);
  const errorKey = skillDraftError(draft);
  // The starter document means a new skill draft is never empty; what makes it
  // pristine is that the parts only the user can write are still blank.
  const pristine = !editing && !draft.name.trim() && !draft.description.trim();
  const bytes = new TextEncoder().encode(draft.body).length;
  const slug = draft.id || skillSlug(draft.name);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) =>
    setDraft({ ...draft, [key]: value });

  // Naming a new skill seeds the body once, so the editor is never a blank page
  // but never overwrites something the user has started writing either.
  const setName = (value: string) => {
    const next: SkillDraft = { ...draft, name: value };
    if (!nameTouched && !editing && !draft.body.trim()) next.body = skillTemplate(value);
    setDraft(next);
  };

  return (
    <div
      className="overlay ext-sheet-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div className="dialog ext-sheet" role="dialog" aria-modal aria-labelledby="skill-sheet-title">
        <div className="ext-sheet-head">
          <div>
            <h3 id="skill-sheet-title" className="ext-sheet-title">
              {editing ? t("extensions.skills.editTitle") : t("extensions.skills.addTitle")}
            </h3>
            <p className="ext-sheet-sub">{t("extensions.skills.sheetSubtitle")}</p>
          </div>
          <button
            type="button"
            className="ext-sheet-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <IconX size={14} />
          </button>
        </div>

        <div className="ext-sheet-body">
          <Field
            label={t("extensions.skills.name")}
            hint={
              slug
                ? t("extensions.skills.slugHint", { id: slug })
                : t("extensions.skills.nameHint")
            }
          >
            <Input
              value={draft.name}
              autoFocus={!editing}
              placeholder={t("extensions.skills.namePlaceholder")}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
            />
          </Field>

          <Field
            label={t("extensions.skills.description")}
            hint={t("extensions.skills.descriptionHint")}
          >
            <Textarea
              value={draft.description}
              rows={2}
              placeholder={t("extensions.skills.descriptionPlaceholder")}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>

          <div className="ext-field-group">
            <div className="ext-field-label ext-field-label-row">
              <span>{t("extensions.skills.body")}</span>
              <span
                className={
                  bytes > MAX_SKILL_BYTES
                    ? "ext-byte-count is-over"
                    : bytes > MAX_SKILL_BYTES * 0.8
                      ? "ext-byte-count is-near"
                      : "ext-byte-count"
                }
              >
                {t("extensions.skills.bytes", {
                  used: Math.round(bytes / 1024),
                  max: Math.round(MAX_SKILL_BYTES / 1024),
                })}
              </span>
            </div>
            <p className="ext-field-hint">{t("extensions.skills.bodyHint")}</p>
            <Textarea
              className="ext-skill-body"
              value={draft.body}
              rows={14}
              spellCheck={false}
              placeholder={skillTemplate("")}
              aria-label={t("extensions.skills.body")}
              onChange={(event) => set("body", event.target.value)}
            />
          </div>

          <div className="ext-field-group">
            <div className="ext-field-label">{t("settings.scope")}</div>
            <p className="ext-field-hint">{t("settings.scopeHint")}</p>
            <ManagementScope
              draft={draft}
              setDraft={setDraft}
              level={level}
              projectName={projectName}
            />
          </div>
</div>

        {errorKey && !pristine ? <p className="ext-sheet-error">{t(errorKey)}</p> : null}
        <div className="ext-sheet-actions">
          {editing && onReveal ? (
            <Button variant="ghost" onClick={onReveal}>
              <IconFolderOpen size={13} />
              {t("extensions.skills.reveal")}
            </Button>
          ) : (
            <span className="ext-sheet-note">{t("extensions.skills.sheetNote")}</span>
          )}
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
