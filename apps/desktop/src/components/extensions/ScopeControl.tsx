import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  activationState,
  normalizeProjectPath,
  resolveScope,
  withProject,
  withoutProject,
  type ActivationScope,
  type ActivationState,
  type ProjectRecord,
} from "@pi-desktop/shared";
import { cx } from "../ui";
import {
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconGlobe,
  IconPower,
  IconSearch,
  IconX,
} from "../icons";

/**
 * The one control that answers both questions an extension raises: is it on, and
 * where does it apply. Plugins, MCP servers and user skills all render this, so a
 * user learns the affordance once.
 *
 * The full form keeps all three states visible. Dense installed-plugin rows use
 * one current-state trigger instead, with the same three choices in a small
 * menu so the row does not become a second toolbar.
 */
export type ScopeTarget = {
  enabled: boolean;
  scope?: ActivationScope;
};

export type ScopeControlProps = {
  target: ScopeTarget;
  /** Accessible name of the thing being scoped, e.g. the plugin's name. */
  label: string;
  /** The project open in this window, offered first by the This project choice. */
  currentProjectPath?: string | null;
  /** Everything the picker can offer, newest-first as the sidebar orders them. */
  projects: readonly ProjectRecord[];
  onSetEnabled: (enabled: boolean) => void | Promise<void>;
  onSetScope: (scope: ActivationScope) => void | Promise<void>;
  disabled?: boolean;
  /** Renders one current-state trigger with a menu, for dense rows. */
  compact?: boolean;
};

const STATE_ORDER: ActivationState[] = ["off", "projects", "global"];

const STATE_LABEL_KEYS: Record<ActivationState, string> = {
  off: "extensions.scope.off",
  projects: "extensions.scope.projects",
  global: "extensions.scope.global",
};

const STATE_HINT_KEYS: Record<ActivationState, string> = {
  off: "extensions.scope.offHint",
  projects: "extensions.scope.projectsHint",
  global: "extensions.scope.globalHint",
};

/** Trailing path segment, which is what the user recognizes a project by. */
export function projectLabel(path: string): string {
  const normalized = normalizeProjectPath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized || path;
}

function StateIcon({ state }: { state: ActivationState }) {
  if (state === "off") return <IconPower size={13} />;
  if (state === "projects") return <IconFolder size={13} />;
  return <IconGlobe size={13} />;
}

export function ScopeControl({
  target,
  label,
  currentProjectPath,
  projects,
  onSetEnabled,
  onSetScope,
  disabled,
  compact,
}: ScopeControlProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const compactWrapRef = useRef<HTMLDivElement | null>(null);
  const [compactFlipUp, setCompactFlipUp] = useState(false);
  const state = activationState(target);
  const scope = resolveScope(target.scope);

  useEffect(() => {
    if (!compact || !compactOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!compactWrapRef.current?.contains(event.target as Node)) {
        setCompactOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setCompactOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [compact, compactOpen]);

  useLayoutEffect(() => {
    if (!compact || !compactOpen) return;
    const rect = compactWrapRef.current?.getBoundingClientRect();
    if (rect) setCompactFlipUp(window.innerHeight - rect.bottom < 220);
  }, [compact, compactOpen]);

  const select = (next: ActivationState) => {
    if (disabled) return;
    setCompactOpen(false);
    if (next === state && next !== "projects") return;
    if (next === "off") {
      void onSetEnabled(false);
      setPickerOpen(false);
      return;
    }
    if (next === "global") {
      // Keep the project list: a user who widens a scope and narrows it again
      // should get their selection back, not an empty list.
      void onSetScope({ mode: "global", projects: scope.projects });
      if (!target.enabled) void onSetEnabled(true);
      setPickerOpen(false);
      return;
    }
    // "This project" with nothing selected yet seeds itself from the window, so
    // the common case — scope this to what I have open — needs no second step.
    if (scope.projects.length === 0 && currentProjectPath) {
      void onSetScope(withProject(scope, currentProjectPath));
      if (!target.enabled) void onSetEnabled(true);
      setPickerOpen(true);
      return;
    }
    if (state !== "projects") {
      void onSetScope({ mode: "projects", projects: scope.projects });
      if (!target.enabled) void onSetEnabled(true);
    }
    setPickerOpen((open) => !open);
  };

  const currentStateLabel =
    state === "projects" && scope.projects.length > 0
      ? t("extensions.scope.projectCount", { count: scope.projects.length })
      : t(STATE_LABEL_KEYS[state]);

  return (
    <div className={cx("scope-control", compact && "is-compact")}>
      {compact ? (
        <div className="scope-compact-wrap" ref={compactWrapRef}>
          <button
            type="button"
            className={cx("scope-compact-trigger", `is-${state}`)}
            aria-label={`${t("extensions.scope.ariaLabel", { name: label })}: ${currentStateLabel}`}
            aria-haspopup={pickerOpen ? "dialog" : "menu"}
            aria-expanded={compactOpen || pickerOpen}
            title={t(STATE_HINT_KEYS[state])}
            data-tip={t(STATE_HINT_KEYS[state])}
            disabled={disabled}
            onClick={() => {
              if (pickerOpen) {
                setPickerOpen(false);
                return;
              }
              setCompactOpen((open) => !open);
            }}
          >
            <StateIcon state={state} />
            <span className="scope-compact-label">{currentStateLabel}</span>
            <IconChevronDown className="scope-compact-chevron" size={12} />
          </button>
          {compactOpen ? (
            <div
              className={cx("scope-compact-menu", compactFlipUp && "is-up")}
              role="menu"
              aria-label={t("extensions.scope.ariaLabel", { name: label })}
            >
              {STATE_ORDER.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={state === option}
                  className={cx("scope-compact-option", state === option && "is-active")}
                  title={t(STATE_HINT_KEYS[option])}
                  disabled={disabled}
                  onClick={() => select(option)}
                >
                  <StateIcon state={option} />
                  <span className="scope-compact-option-copy">
                    <span className="scope-compact-option-label">
                      {t(STATE_LABEL_KEYS[option])}
                    </span>
                    <span className="scope-compact-option-hint">
                      {t(STATE_HINT_KEYS[option])}
                    </span>
                  </span>
                  {state === option ? <IconCheck size={13} /> : null}
                </button>
              ))}
            </div>
          ) : null}
          {state === "projects" ? (
            <ScopeProjectsSummary
              compact
              anchorRef={compactWrapRef}
              scope={scope}
              projects={projects}
              currentProjectPath={currentProjectPath}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onSetScope={onSetScope}
              label={label}
            />
          ) : null}
        </div>
      ) : (
        <>
          <div
            className="scope-track"
            role="radiogroup"
            aria-label={t("extensions.scope.ariaLabel", { name: label })}
          >
            {STATE_ORDER.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={state === option}
                className={cx("scope-seg", state === option && "is-active")}
                title={t(STATE_HINT_KEYS[option])}
                disabled={disabled}
                onClick={() => select(option)}
              >
                <StateIcon state={option} />
                <span>{t(STATE_LABEL_KEYS[option])}</span>
              </button>
            ))}
          </div>
          {state === "projects" ? (
            <ScopeProjectsSummary
              scope={scope}
              projects={projects}
              currentProjectPath={currentProjectPath}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onSetScope={onSetScope}
              label={label}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The project summary for the full control, plus the popover that edits the
 * selected folders. The compact row keeps only the popover and folds its count
 * into the current-state trigger.
 */
function ScopeProjectsSummary({
  compact = false,
  anchorRef,
  scope,
  projects,
  currentProjectPath,
  open,
  onOpenChange,
  onSetScope,
  label,
}: {
  compact?: boolean;
  anchorRef?: { current: HTMLElement | null };
  scope: ActivationScope;
  projects: readonly ProjectRecord[];
  currentProjectPath?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetScope: (scope: ActivationScope) => void | Promise<void>;
  label: string;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [flipUp, setFlipUp] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  // Measured before paint: a popover that opens downwards and then jumps up
  // reads as a glitch.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = (anchorRef ?? wrapRef).current?.getBoundingClientRect();
    if (rect) setFlipUp(window.innerHeight - rect.bottom < 320);
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  /**
   * The window's project is pinned to the top even when it was never saved as a
   * project record, and any path already in the scope is listed even if the
   * project has since been closed — otherwise a scope could not be undone from
   * here.
   */
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ path: string; name: string; current: boolean }> = [];
    const push = (path: string, name: string) => {
      const key = normalizeProjectPath(path).toLocaleLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({
        path: normalizeProjectPath(path),
        name: name || projectLabel(path),
        current: key === normalizeProjectPath(currentProjectPath ?? "").toLocaleLowerCase(),
      });
    };
    if (currentProjectPath) push(currentProjectPath, projectLabel(currentProjectPath));
    for (const entry of scope.projects) push(entry, projectLabel(entry));
    for (const project of projects) push(project.path, project.name);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return out;
    return out.filter(
      (row) =>
        row.name.toLocaleLowerCase().includes(needle) ||
        row.path.toLocaleLowerCase().includes(needle),
    );
  }, [scope.projects, projects, currentProjectPath, query]);

  const selected = new Set(scope.projects.map((path) => path.toLocaleLowerCase()));
  const isSelected = (path: string) => selected.has(normalizeProjectPath(path).toLocaleLowerCase());

  const toggle = (path: string) => {
    const next = isSelected(path) ? withoutProject(scope, path) : withProject(scope, path);
    void onSetScope(next);
  };

  const count = scope.projects.length;

  return (
    <div className={cx("scope-projects", compact && "is-compact")} ref={wrapRef}>
      {!compact ? (
        <>
          <button
            type="button"
            className={cx("scope-chip", count === 0 && "is-empty", open && "is-open")}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
          >
            <IconFolder size={12} />
            {count === 0
              ? t("extensions.scope.pickProjects")
              : count === 1
                ? projectLabel(scope.projects[0])
                : t("extensions.scope.projectCount", { count })}
          </button>
          {count === 0 ? (
            <span className="scope-warn" role="status">
              {t("extensions.scope.noProjectsWarning")}
            </span>
          ) : null}
        </>
      ) : null}
      {open ? (
        <div
          className={cx("scope-popover", flipUp && "is-up")}
          role="dialog"
          aria-label={t("extensions.scope.pickerTitle", { name: label })}
        >
          <div className="scope-popover-head">
            <div className="scope-popover-title">{t("extensions.scope.pickerTitle", { name: label })}</div>
            <button
              type="button"
              className="scope-popover-close"
              aria-label={t("common.close")}
              onClick={() => onOpenChange(false)}
            >
              <IconX size={12} />
            </button>
          </div>
          <div className="scope-popover-search">
            <IconSearch size={12} />
            <input
              value={query}
              autoFocus
              spellCheck={false}
              placeholder={t("extensions.scope.searchProjects")}
              aria-label={t("extensions.scope.searchProjects")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="scope-popover-list" role="listbox" aria-multiselectable>
            {rows.length === 0 ? (
              <p className="scope-popover-empty">{t("extensions.scope.noProjects")}</p>
            ) : (
              rows.map((row) => {
                const on = isSelected(row.path);
                return (
                  <button
                    key={row.path}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={cx("scope-option", on && "is-on")}
                    onClick={() => toggle(row.path)}
                  >
                    <span className="scope-option-check" aria-hidden>
                      {on ? <IconCheck size={12} /> : null}
                    </span>
                    <span className="scope-option-copy">
                      <span className="scope-option-name">
                        {row.name}
                        {row.current ? (
                          <span className="scope-option-tag">{t("extensions.scope.currentProject")}</span>
                        ) : null}
                      </span>
                      <span className="scope-option-path">{row.path}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <p className="scope-popover-foot">{t("extensions.scope.subdirectoryNote")}</p>
        </div>
      ) : null}
    </div>
  );
}
