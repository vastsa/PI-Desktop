import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  isNonLoopbackHttpMcpUrl,
  type AgentCapabilityLevel,
  resolveScope,
  type ActivationScope,
  type McpServerInput,
  type McpServerRecord,
  type McpServerStatus,
  type McpTransport,
  type ProjectRecord,
} from "@pi-desktop/shared";
import { Button, Field, Input, cx } from "../ui";
import { IconPlay, IconServer, IconTerminal, IconX } from "../icons";
import { ScopeControl } from "./ScopeControl";
import { KeyValueRows, pairsToRecord, recordToPairs, type KeyValuePair } from "./KeyValueRows";

/**
 * Create/edit sheet for one user-owned MCP server.
 *
 * The transport choice comes first because it decides what the rest of the form
 * even means, and the two branches never both show: a form that asks for a URL
 * and a command at the same time invites a config that is half of each.
 */
export type McpDraft = {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: KeyValuePair[];
  url: string;
  headers: KeyValuePair[];
  enabled: boolean;
  scope: ActivationScope;
};

export function emptyMcpDraft(): McpDraft {
  return {
    id: "",
    label: "",
    description: "",
    transport: "stdio",
    command: "",
    args: "",
    env: [],
    url: "",
    headers: [],
    enabled: true,
    scope: GLOBAL_SCOPE,
  };
}

export function draftFromRecord(record: McpServerRecord): McpDraft {
  return {
    id: record.id,
    label: record.label ?? "",
    description: record.description ?? "",
    transport: record.transport,
    command: record.command ?? "",
    args: (record.args ?? []).join(" "),
    env: recordToPairs(record.env),
    url: record.url ?? "",
    headers: recordToPairs(record.headers),
    enabled: record.enabled,
    scope: resolveScope(record.scope),
  };
}

/**
 * Split a command line into arguments, honouring quotes.
 *
 * The field takes one line because that is how every MCP README prints the
 * command, and asking the user to re-key `npx -y pkg` as three rows would be
 * hostile. Quoted segments survive so a path with a space still arrives as one
 * argument.
 */
export function splitArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** Slug host-core will accept: starts with a letter, `[A-Za-z0-9_-]` after. */
export function mcpIdFromLabel(label: string): string {
  const cleaned = label
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return /^[a-z]/.test(cleaned) ? cleaned : "";
}

export function draftToInput(
  draft: McpDraft,
  context?: { level?: AgentCapabilityLevel; projectPath?: string },
): McpServerInput {
  const base = {
    id: draft.id.trim(),
    ...(context?.level ? { level: context.level } : {}),
    ...(context?.projectPath ? { projectPath: context.projectPath } : {}),
    label: draft.label.trim() || draft.id.trim(),
    description: draft.description.trim() || undefined,
    enabled: draft.enabled,
    scope: draft.scope,
  };
  if (draft.transport === "http") {
    return {
      ...base,
      transport: "http",
      url: draft.url.trim(),
      headers: pairsToRecord(draft.headers),
    };
  }
  return {
    ...base,
    transport: "stdio",
    command: draft.command.trim(),
    args: splitArgs(draft.args),
    env: pairsToRecord(draft.env),
  };
}

function ManagementScope({
  draft,
  setDraft,
  level,
  projectName,
}: {
  draft: McpDraft;
  setDraft: (next: McpDraft) => void;
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
            ? t("settings.globalScopeHint")
            : t("settings.projectScopeHint")}
        </span>
      </div>
      <button
        type="button"
        className={cx("settings-toggle", draft.enabled && "on")}
        role="switch"
        aria-checked={draft.enabled}
        aria-label={t("settings.enableCapability", { name: draft.label || draft.id })}
        onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
      >
        <span className="settings-toggle-thumb" />
      </button>
    </div>
  );
}

/** Client-side mirror of host-core's rules, so the form can explain itself. */
export function mcpDraftError(draft: McpDraft): string | null {
  if (!draft.id.trim()) return "extensions.mcp.errorId";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(draft.id.trim())) return "extensions.mcp.errorIdShape";
  if (draft.transport === "stdio") {
    if (!draft.command.trim()) return "extensions.mcp.errorCommand";
    if (draft.command.includes("..")) return "extensions.mcp.errorCommandDots";
    return null;
  }
  const url = draft.url.trim();
  if (!url) return "extensions.mcp.errorUrl";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "extensions.mcp.errorUrlShape";
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return null;
  return "extensions.mcp.errorUrlScheme";
}

export function McpEditorSheet({
  draft,
  setDraft,
  editing,
  saving,
  status,
  testing,
  projects,
  currentProjectPath,
  onClose,
  onSave,
  onTest,
  managementLevel,
  managementProjectName,
}: {
  draft: McpDraft;
  setDraft: (next: McpDraft) => void;
  /** The record being edited, or null when creating: the id is immutable once saved. */
  editing: McpServerRecord | null;
  saving: boolean;
  status?: McpServerStatus;
  testing: boolean;
  projects: readonly ProjectRecord[];
  currentProjectPath?: string | null;
  onClose: () => void;
  onSave: () => void;
  onTest: () => void;
  /** When set, render the compact global/project scope instead of ScopeControl. */
  managementLevel?: AgentCapabilityLevel;
  managementProjectName?: string;
}) {
  const { t } = useTranslation();
  const [idTouched, setIdTouched] = useState(!!editing);
  const errorKey = mcpDraftError(draft);
  // A form the user has not started saying "an identifier is required" scolds
  // them for opening it. The message appears once there is something to correct.
  const pristine =
    !editing &&
    !draft.id.trim() &&
    !draft.label.trim() &&
    !draft.command.trim() &&
    !draft.url.trim();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const set = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) =>
    setDraft({ ...draft, [key]: value });

  // Typing a name fills the id until the user takes it over, so the common path
  // never asks for two spellings of the same thing.
  const setLabel = (value: string) => {
    if (idTouched) {
      setDraft({ ...draft, label: value });
      return;
    }
    setDraft({ ...draft, label: value, id: mcpIdFromLabel(value) });
  };

  const transports: Array<{
    id: McpTransport;
    icon: ReactNode;
    labelKey: string;
    hintKey: string;
  }> = useMemo(
    () => [
      {
        id: "stdio",
        icon: <IconTerminal size={14} />,
        labelKey: "extensions.mcp.transportStdio",
        hintKey: "extensions.mcp.transportStdioHint",
      },
      {
        id: "http",
        icon: <IconServer size={14} />,
        labelKey: "extensions.mcp.transportHttp",
        hintKey: "extensions.mcp.transportHttpHint",
      },
    ],
    [],
  );
  const insecureHttp =
    draft.transport === "http" && isNonLoopbackHttpMcpUrl(draft.url.trim());

  return (
    <div
      className="overlay ext-sheet-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div className="dialog ext-sheet" role="dialog" aria-modal aria-labelledby="mcp-sheet-title">
        <div className="ext-sheet-head">
          <div>
            <h3 id="mcp-sheet-title" className="ext-sheet-title">
              {editing ? t("extensions.mcp.editTitle") : t("extensions.mcp.addTitle")}
            </h3>
            <p className="ext-sheet-sub">
              {managementLevel === "project" && managementProjectName
                ? t("settings.mcpProjectSubtitle", { project: managementProjectName })
                : t("extensions.mcp.sheetSubtitle")}
            </p>
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
          <div className="ext-field-group">
            <div className="ext-field-label">{t("extensions.mcp.transport")}</div>
            <div className="ext-transport-pick" role="radiogroup" aria-label={t("extensions.mcp.transport")}>
              {transports.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={draft.transport === option.id}
                  className={cx("ext-transport-card", draft.transport === option.id && "is-active")}
                  onClick={() => set("transport", option.id)}
                >
                  <span className="ext-transport-icon" aria-hidden>
                    {option.icon}
                  </span>
                  <span className="ext-transport-copy">
                    <span className="ext-transport-name">{t(option.labelKey)}</span>
                    <span className="ext-transport-hint">{t(option.hintKey)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="ext-field-pair">
            <Field label={t("extensions.mcp.label")} hint={t("extensions.mcp.labelHint")}>
              <Input
                value={draft.label}
                placeholder={t("extensions.mcp.labelPlaceholder")}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <Field label={t("extensions.mcp.id")} hint={t("extensions.mcp.idHint")}>
              <Input
                value={draft.id}
                disabled={!!editing}
                placeholder="context7"
                onChange={(event) => {
                  setIdTouched(true);
                  set("id", event.target.value);
                }}
              />
            </Field>
          </div>

          {draft.transport === "stdio" ? (
            <>
              <Field label={t("extensions.mcp.command")} hint={t("extensions.mcp.commandHint")}>
                <Input
                  value={draft.command}
                  placeholder="npx"
                  onChange={(event) => set("command", event.target.value)}
                />
              </Field>
              <Field label={t("extensions.mcp.args")} hint={t("extensions.mcp.argsHint")}>
                <Input
                  value={draft.args}
                  placeholder="-y @upstash/context7-mcp"
                  onChange={(event) => set("args", event.target.value)}
                />
              </Field>
              <div className="ext-field-group">
                <div className="ext-field-label">{t("extensions.mcp.env")}</div>
                <p className="ext-field-hint">{t("extensions.mcp.envHint")}</p>
                <KeyValueRows
                  pairs={draft.env}
                  onChange={(next) => set("env", next)}
                  keyPlaceholder="API_KEY"
                  valuePlaceholder={t("extensions.mcp.valuePlaceholder")}
                  addLabel={t("extensions.mcp.addEnv")}
                  secret
                />
              </div>
            </>
          ) : (
            <>
              <Field label={t("extensions.mcp.url")} hint={t("extensions.mcp.urlHint")}>
                <Input
                  value={draft.url}
                  placeholder="https://mcp.example.com/sse"
                  onChange={(event) => set("url", event.target.value)}
                />
              </Field>
              {insecureHttp ? (
                <p className="ext-sheet-warning" role="note">
                  {t("extensions.mcp.insecureHttpWarning")}
                </p>
              ) : null}
              <div className="ext-field-group">
                <div className="ext-field-label">{t("extensions.mcp.headers")}</div>
                <p className="ext-field-hint">{t("extensions.mcp.headersHint")}</p>
                <KeyValueRows
                  pairs={draft.headers}
                  onChange={(next) => set("headers", next)}
                  keyPlaceholder="Authorization"
                  valuePlaceholder={t("extensions.mcp.valuePlaceholder")}
                  addLabel={t("extensions.mcp.addHeader")}
                  secret
                />
              </div>
            </>
          )}

          <Field label={t("extensions.mcp.description")} hint={t("extensions.mcp.descriptionHint")}>
            <Input
              value={draft.description}
              placeholder={t("extensions.mcp.descriptionPlaceholder")}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>

          <div className="ext-field-group">
            <div className="ext-field-label">
              {managementLevel ? t("settings.scope") : t("extensions.scope.title")}
            </div>
            <p className="ext-field-hint">
              {managementLevel ? t("settings.scopeHint") : t("extensions.scope.sheetHint")}
            </p>
            {managementLevel ? (
              <ManagementScope
                draft={draft}
                setDraft={setDraft}
                level={managementLevel}
                projectName={managementProjectName}
              />
            ) : (
              <ScopeControl
                target={{ enabled: draft.enabled, scope: draft.scope }}
                label={draft.label || draft.id || t("extensions.mcp.thisServer")}
                projects={projects}
                currentProjectPath={currentProjectPath}
                onSetEnabled={(enabled) => set("enabled", enabled)}
                onSetScope={(scope) => setDraft({ ...draft, scope, enabled: true })}
              />
            )}
          </div>

          {status && status.state !== "idle" ? (
            <div className={cx("ext-test-result", `is-${status.state}`)} role="status">
              <span className="ext-test-dot" aria-hidden />
              <span className="ext-test-copy">
                {status.state === "ready"
                  ? t("extensions.mcp.testReady", { count: status.toolCount })
                  : status.state === "connecting"
                    ? t("extensions.mcp.testConnecting")
                    : status.message || t("extensions.mcp.testFailed")}
              </span>
              {status.state === "ready" && status.toolNames?.length ? (
                <span className="ext-test-tools">{status.toolNames.join(" · ")}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        {errorKey && !pristine ? <p className="ext-sheet-error">{t(errorKey)}</p> : null}
        <div className="ext-sheet-actions">
          {editing ? (
            <Button variant="ghost" disabled={testing} onClick={onTest}>
              <IconPlay size={13} />
              {testing ? t("extensions.mcp.testing") : t("extensions.mcp.test")}
            </Button>
          ) : (
            <span className="ext-sheet-note">{t("extensions.mcp.testAfterSave")}</span>
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
