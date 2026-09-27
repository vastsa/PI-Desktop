import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { ProjectRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Select, cx } from "../ui";
import {
  IconChevronDown,
  IconFolder,
  IconFolderOpen,
  IconMore,
  IconSearch,
  IconX,
} from "../icons";

export type AgentProjectOption = {
  name: string;
  path: string;
};

/** Which level the workbench is currently showing. */
export type CapabilityFilter = "all" | "global" | "project";

/** How long an armed delete stays armed before it disarms itself. */
const DELETE_CONFIRM_MS = 3200;

export function projectDisplayName(path: string, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim();
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || path;
}

/** Recent projects plus the project currently open in the window. */
export function useAgentProjects() {
  const currentProjectPath = useAppStore((state) => state.workspace?.path ?? null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(
    currentProjectPath,
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .listProjects()
      .then((result) => {
        if (cancelled) return;
        setProjects(result.projects ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (currentProjectPath) setSelectedProjectPath(currentProjectPath);
  }, [currentProjectPath]);

  const options = useMemo<AgentProjectOption[]>(() => {
    const seen = new Set<string>();
    const result: AgentProjectOption[] = [];
    const add = (path: string | null | undefined, name?: string) => {
      const normalized = path?.trim();
      if (!normalized) return;
      const key = normalized.toLocaleLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ path: normalized, name: projectDisplayName(normalized, name) });
    };
    add(currentProjectPath);
    for (const project of projects) add(project.path, project.name);
    return result;
  }, [currentProjectPath, projects]);

  useEffect(() => {
    if (options.length === 0) {
      if (selectedProjectPath) setSelectedProjectPath(null);
      return;
    }
    if (
      !selectedProjectPath ||
      !options.some((project) => project.path === selectedProjectPath)
    ) {
      setSelectedProjectPath(options[0].path);
    }
  }, [options, selectedProjectPath]);

  return {
    currentProjectPath,
    selectedProjectPath,
    setSelectedProjectPath,
    projects,
    options,
  };
}

/**
 * A delete that needs two clicks. The first click arms the action and the
 * caller relabels it; the arm expires on its own so a row never stays one
 * stray click away from losing a file.
 */
export function useArmedDelete() {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), DELETE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return { armed, setArmed };
}

/** Case-insensitive substring match across whichever fields a row exposes. */
export function matchesCapabilitySearch(
  query: string,
  ...fields: readonly (string | undefined | null)[]
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}

export function AgentProjectPicker({
  value,
  options,
  label,
  disabled,
  onChange,
}: {
  value: string | null;
  options: readonly AgentProjectOption[];
  label: string;
  disabled?: boolean;
  onChange: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="agent-capability-project-picker">
      <span className="sr-only">{label}</span>
      <IconFolder size={13} aria-hidden="true" />
      <Select
        value={value ?? ""}
        aria-label={label}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.length === 0 ? (
          <option value="">{t("settings.noProjects")}</option>
        ) : (
          options.map((project) => (
            <option key={project.path} value={project.path}>
              {project.name}
            </option>
          ))
        )}
      </Select>
      <IconChevronDown size={12} aria-hidden="true" />
    </label>
  );
}

export function CapabilityToggle({
  checked,
  label,
  disabled,
  busy,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      className={cx("settings-toggle", checked && "on", busy && "is-busy")}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={onChange}
    >
      <span className="settings-toggle-thumb" />
    </button>
  );
}

/**
 * Page shell. The heading is owned by SettingsPage, so this contributes the
 * description, the toolbar, and the single panel the rows live in.
 */
export function AgentCapabilityPage({
  description: _description,
  note: _note,
  toolbar,
  children,
  className,
}: {
  description: string;
  note?: string;
  toolbar: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("agent-capability-page", className)}>
      {toolbar}
      {children}
    </div>
  );
}

/**
 * One toolbar for the whole page: the level filter demoted from a page section
 * to a segmented control with live counts, one search field, the project the
 * project level resolves against, and the page's primary actions.
 */
export function CapabilityToolbar({
  filter,
  onFilterChange,
  counts,
  search,
  onSearchChange,
  searchPlaceholder,
  projectPicker,
  actions,
}: {
  /** Omit to hide the filter entirely, as the global-only subagents page does. */
  filter?: CapabilityFilter;
  onFilterChange?: (filter: CapabilityFilter) => void;
  counts?: { all: number; global: number; project: number };
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  projectPicker?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const segments: readonly { id: CapabilityFilter; label: string; count: number }[] =
    counts
      ? [
          { id: "all", label: t("settings.capabilityFilterAll"), count: counts.all },
          {
            id: "global",
            label: t("settings.capabilityFilterGlobal"),
            count: counts.global,
          },
          {
            id: "project",
            label: t("settings.capabilityFilterProject"),
            count: counts.project,
          },
        ]
      : [];
  return (
    <div className="agent-capability-toolbar">
      {filter && onFilterChange && segments.length > 0 ? (
        <div
          className="settings-segment agent-capability-segment"
          role="radiogroup"
          aria-label={t("settings.capabilityFilterLabel")}
        >
          {segments.map((segment) => (
            <button
              key={segment.id}
              type="button"
              role="radio"
              aria-checked={filter === segment.id}
              className={cx(
                "settings-segment-item",
                "agent-capability-segment-btn",
                filter === segment.id && "active",
              )}
              onClick={() => onFilterChange(segment.id)}
            >
              {segment.label}
              <span className="agent-capability-segment-count">{segment.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="agent-capability-search-wrap">
        <IconSearch size={13} aria-hidden="true" />
        <input
          className="agent-capability-search"
          type="search"
          value={search}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {search ? (
          <button
            type="button"
            className="agent-capability-search-clear"
            aria-label={t("settings.clearSearch")}
            onClick={() => onSearchChange("")}
          >
            <IconX size={11} />
          </button>
        ) : null}
      </div>
      {projectPicker}
      {actions ? <div className="agent-capability-toolbar-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * The one panel every row lives in. `loading` is first paint only; a refresh
 * that already has rows to show keeps them and dims instead, so toggling a
 * switch never replaces the list with skeletons.
 */
export function CapabilityPanel({
  loading,
  refreshing,
  loadingLabel,
  children,
}: {
  loading: boolean;
  refreshing?: boolean;
  loadingLabel: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cx(
        "settings-panel",
        "agent-capability-panel",
        refreshing && !loading && "is-refreshing",
      )}
    >
      {refreshing && !loading ? (
        <span className="sr-only" role="status" aria-live="polite">
          {t("settings.capabilityRefreshing")}
        </span>
      ) : null}
      <div className="agent-capability-list" role="list" aria-busy={loading || undefined}>
        {loading ? <CapabilitySkeleton label={loadingLabel} /> : children}
      </div>
    </div>
  );
}

/** Level divider inside the panel: which level, where it lives, how many. */
export function CapabilityGroupHeader({
  label,
  path,
  count,
  action,
}: {
  label: string;
  path: string;
  count: number;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="agent-capability-group" role="presentation">
      <span className="agent-capability-group-label">{label}</span>
      <code className="agent-capability-group-path" title={path}>
        {path}
      </code>
      <span
        className="agent-capability-group-count"
        title={t("settings.capabilityCount", { count })}
      >
        {count}
      </span>
      {action ? <span className="agent-capability-group-action">{action}</span> : null}
    </div>
  );
}

/**
 * One capability. The level badge is on the row itself, not only in the group
 * header, so a row scrolled away from its divider still says where it lives.
 */
export function CapabilityRow({
  glyph,
  glyphState,
  name,
  badges,
  command,
  description,
  meta,
  actions,
  off,
  menuOpen,
}: {
  glyph: ReactNode;
  /** Tints the glyph for capabilities that carry live state, e.g. MCP handshakes. */
  glyphState?: string;
  name: string;
  badges?: ReactNode;
  command?: string;
  description: string;
  meta?: ReactNode;
  actions: ReactNode;
  off?: boolean;
  menuOpen?: boolean;
}) {
  return (
    <div
      className={cx(
        "agent-capability-row",
        off && "is-off",
        menuOpen && "menu-open",
      )}
      role="listitem"
    >
      <span
        className={cx("agent-capability-glyph", glyphState && `is-${glyphState}`)}
        aria-hidden="true"
      >
        {glyph}
      </span>
      <div className="agent-capability-copy">
        <div className="agent-capability-row-title">
          <span className="agent-capability-name">{name}</span>
          {badges}
        </div>
        {command ? (
          <code className="agent-capability-command" title={command}>
            {command}
          </code>
        ) : null}
        <p className="agent-capability-description" title={description}>
          {description}
        </p>
        {meta ? <div className="agent-capability-meta">{meta}</div> : null}
      </div>
      <div className="agent-capability-row-actions">{actions}</div>
    </div>
  );
}

export type CapabilityMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * Overflow menu for one row. Open state is owned by the page so only one row's
 * menu can be open, and Escape or any outside press dismisses it.
 */
export function CapabilityRowMenu({
  label,
  items,
  open,
  disabled,
  onOpenChange,
}: {
  label: string;
  items: readonly CapabilityMenuItem[];
  open: boolean;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div className="agent-capability-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="settings-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <IconMore size={16} />
      </button>
      {open ? (
        <div className="agent-capability-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={cx(item.danger && "danger")}
              disabled={item.disabled}
              onClick={item.onSelect}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Ghost rows that mirror the real row anatomy while the host responds. */
export function CapabilitySkeleton({ label }: { label: string }) {
  return (
    <div className="agent-capability-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="agent-capability-skeleton-row" aria-hidden="true">
          <span className="agent-capability-skeleton-glyph" />
          <span className="agent-capability-skeleton-lines">
            <span className="agent-capability-skeleton-line is-title" />
            <span className="agent-capability-skeleton-line is-desc" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Empty state. `action` keeps it from being a dead end. */
export function CapabilityEmpty({
  message,
  hint,
  icon,
  action,
}: {
  message: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="agent-capability-empty" role="status">
      {icon ?? <IconFolderOpen size={18} aria-hidden="true" />}
      <span className="agent-capability-empty-message">{message}</span>
      {hint ? <span className="agent-capability-empty-hint">{hint}</span> : null}
      {action ? <div className="agent-capability-empty-action">{action}</div> : null}
    </div>
  );
}

export function CapabilityButton({
  children,
  onClick,
  variant = "secondary",
  disabled,
  busy,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  // No `size="sm"`: its utilities live in Tailwind's `utilities` layer while the
  // style partials are unlayered, so `.btn` wins regardless. Toolbar buttons get
  // their compact geometry from `.agent-capability-toolbar-actions > .btn`.
  return (
    <Button
      variant={variant}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      title={title}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
