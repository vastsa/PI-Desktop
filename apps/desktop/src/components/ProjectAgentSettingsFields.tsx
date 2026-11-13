import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_PROJECT_INSTRUCTIONS_BYTES, type ProjectAgentSettings,
  type ProjectCapabilities, type ProjectCapabilityCatalog, type ProjectCapabilityOption,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { Button, Checkbox, Textarea } from "./ui";
import "../styles/project-agent-settings.css";

const EMPTY_CATALOG: ProjectCapabilityCatalog = { skills: [], mcpServers: [] };
export function projectInstructionsTooLarge(value?: string): boolean {
  return new TextEncoder().encode(value ?? "").length > MAX_PROJECT_INSTRUCTIONS_BYTES;
}

/** Shared by creation and editing; selections are stable IDs, never credentials. */
export function ProjectAgentSettingsFields({ projectPath, remote = false, value, onChange, disabled = false }: {
  projectPath?: string;
  remote?: boolean;
  value: ProjectAgentSettings;
  onChange: (value: ProjectAgentSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; catalog: ProjectCapabilityCatalog; error?: string }>();
  const key = JSON.stringify([projectPath, remote, revision]);
  useEffect(() => {
    let cancelled = false;
    void api.listProjectCapabilities(projectPath, remote).then((catalog) => {
      if (!cancelled) setLoaded({ key, catalog });
    }).catch((error: unknown) => {
      if (!cancelled) setLoaded({ key, catalog: EMPTY_CATALOG,
        error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [projectPath, remote, key]);
  const loading = loaded?.key !== key;
  const catalog = loading ? EMPTY_CATALOG : loaded.catalog;
  const error = loading ? undefined : loaded.error;
  const bytes = new TextEncoder().encode(value.instructions ?? "").length;

  const selection = (field: keyof ProjectCapabilities, options: ProjectCapabilityOption[], label: string) => {
    const ids = value.capabilities?.[field];
    const known = new Set(options.map((option) => option.id));
    const missing = (ids ?? []).filter((selected) => !known.has(selected));
    const change = (next: string[] | undefined) => {
      const capabilities = { ...value.capabilities };
      if (next === undefined) delete capabilities[field];
      else capabilities[field] = next;
      onChange({ ...value, capabilities });
    };
    return <div className="project-agent-settings-group" role="group" aria-label={label}>
      <h4 className="project-create-dialog-section-title">{label}</h4>
      <Checkbox label={t("project.agentInherit")} checked={ids === undefined}
        disabled={disabled || loading || Boolean(error)}
        onChange={(event) => change(event.target.checked ? undefined : options.map((option) => option.id))} />
      <div className="project-agent-settings-options">
        {[...options, ...missing.map<ProjectCapabilityOption>((selected) => ({ id: selected, name: selected }))].map((option) => {
          const unavailable = !known.has(option.id);
          return <Checkbox key={option.id} checked={ids === undefined || ids.includes(option.id)}
            disabled={disabled || loading || Boolean(error)}
            label={<span className="project-agent-settings-option"><span>{option.name}</span>
              <small>{unavailable ? t("project.agentUnavailable") : option.description || option.id}</small></span>}
            onChange={(event) => {
              const current = ids ?? options.map((item) => item.id);
              change(event.target.checked ? [...new Set([...current, option.id])] : current.filter((item) => item !== option.id));
            }} />;
        })}
        {!loading && !error && options.length === 0 && missing.length === 0
          ? <p className="project-agent-settings-hint">{t("project.agentEmpty")}</p> : null}
      </div>
    </div>;
  };
  return <section className="project-create-dialog-section project-agent-settings" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="project-create-dialog-section-title">{t("project.agentTitle")}</h3>
    <p className="project-agent-settings-hint">{t("project.agentHint")}</p>
    {loading ? <p role="status">{t("project.agentLoading")}</p> : null}
    {error ? <div role="alert"><p>{t("project.agentLoadError")}: {error}</p>
      <Button type="button" disabled={disabled} onClick={() => setRevision((current) => current + 1)}>{t("project.agentRetry")}</Button>
    </div> : null}
    {selection("skillIds", catalog.skills, t("project.agentSkills"))}
    {selection("mcpServerIds", catalog.mcpServers, t("project.agentMcp"))}
    <label htmlFor={`${id}-instructions`} className="project-create-dialog-field-label">{t("project.agentMarkdown")}</label>
    <p id={`${id}-hint`} className="project-agent-settings-hint">{t("project.agentMarkdownHint")}</p>
    <Textarea id={`${id}-instructions`} rows={6} value={value.instructions ?? ""} disabled={disabled}
      aria-describedby={`${id}-hint ${id}-bytes`} aria-invalid={bytes > MAX_PROJECT_INSTRUCTIONS_BYTES || undefined}
      onChange={(event) => onChange({ ...value, instructions: event.target.value })} />
    <p id={`${id}-bytes`} role={bytes > MAX_PROJECT_INSTRUCTIONS_BYTES ? "alert" : undefined} className="project-agent-settings-hint">
      {t("project.agentBytes", { count: bytes, max: MAX_PROJECT_INSTRUCTIONS_BYTES })}
    </p>
  </section>;
}
