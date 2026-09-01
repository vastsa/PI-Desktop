import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectRecord, SessionSummary } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { Button, cx } from "../components/ui";
import {
  IconArchive,
  IconArchiveRestore,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconMore,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconStar,
  IconX,
} from "../components/icons";
import {
  loadRecentProjects,
  projectColor,
  type RecentProject,
} from "../lib/recent-projects";
import { collectSessionProjects } from "../lib/session-projects";
import {
  normalizeProjectPath,
  sessionMatchesProject,
} from "../lib/sidebar-session-groups";
import { ProjectInstructionsDialog } from "../components/ProjectInstructionsDialog";
import { SessionRenameDialog } from "../components/SessionRenameDialog";

const INITIAL_VISIBLE_SESSION_COUNT = 8;

type SortMode = "recent" | "name";

/**
 * Section order for the always-visible index. Archived records are grouped last
 * rather than hidden, so the archive never needs a visibility toggle (D133).
 */
type GroupId = "pinned" | "projects" | "archived";

const GROUP_ORDER: GroupId[] = ["pinned", "projects", "archived"];

const GROUP_LABEL_KEYS: Record<GroupId, string> = {
  pinned: "project.groupPinned",
  projects: "project.groupProjects",
  archived: "project.groupArchived",
};

function formatUpdated(ts?: number, locale?: string, neverLabel = "—") {
  if (!ts) return neverLabel;
  try {
    const elapsed = Date.now() - ts;
    const minutes = Math.round(elapsed / 60_000);
    if (minutes < 60 * 24 * 7) {
      const rtf = new Intl.RelativeTimeFormat(locale || undefined, {
        numeric: "auto",
      });
      if (minutes < 60) return rtf.format(-Math.max(minutes, 0), "minute");
      if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), "hour");
      return rtf.format(-Math.round(minutes / (60 * 24)), "day");
    }
    const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
    return new Intl.DateTimeFormat(locale || undefined, {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    }).format(new Date(ts));
  } catch {
    return neverLabel;
  }
}

function shortenPath(path: string) {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sessionTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sessionMatchesQuery(session: SessionSummary, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return (
    !normalizedQuery ||
    session.title.toLocaleLowerCase().includes(normalizedQuery) ||
    session.id.toLocaleLowerCase().includes(normalizedQuery)
  );
}

export function ProjectsPage() {
  const { t, i18n } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const openProjectPaths = useAppStore((s) => s.openProjectPaths);
  const projectMeta = useAppStore((s) => s.projectMeta);
  const openProject = useAppStore((s) => s.openProject);
  const activateProject = useAppStore((s) => s.activateProject);
  const clearProject = useAppStore((s) => s.clearProject);
  const closeProject = useAppStore((s) => s.closeProject);
  const toggleProjectPinned = useAppStore((s) => s.toggleProjectPinned);
  const archiveProject = useAppStore((s) => s.archiveProject);
  const restoreProject = useAppStore((s) => s.restoreProject);
  const newSession = useAppStore((s) => s.newSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const renameSession = useAppStore((s) => s.renameSession);
  const showToast = useAppStore((s) => s.showToast);
  const sessions = useAppStore((s) => s.sessions);
  const [recents, setRecents] = useState<RecentProject[]>(() => loadRecentProjects());
  const [durableProjects, setDurableProjects] = useState<ProjectRecord[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<Record<string, number>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [instructionsFor, setInstructionsFor] = useState<{
    name: string;
    path: string;
  } | null>(null);

  useEffect(() => {
    let canceled = false;
    void api
      .listProjects()
      .then(({ projects }) => {
        if (!canceled) setDurableProjects(projects);
      })
      .catch(() => {
        // Session-derived entries below keep the index useful if host listing fails.
      });
    return () => {
      canceled = true;
    };
  }, [sessions]);

  // Row menus are popovers: Escape or any outside press dismisses them so a menu
  // never outlives the row the pointer left.
  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuFor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuFor]);

  const items = useMemo(() => {
    const byPath = new Map<string, RecentProject>();
    for (const project of durableProjects) {
      const key = normalizeProjectPath(project.path);
      if (!key) continue;
      byPath.set(key, {
        path: project.path,
        name: project.name,
        openedAt: project.lastOpenedAt,
        pinned: project.pinned,
        color: projectColor(project.path),
      });
    }
    for (const project of recents) {
      const key = normalizeProjectPath(project.path);
      if (!key) continue;
      const existing = byPath.get(key);
      byPath.set(key, {
        ...existing,
        ...project,
        openedAt: Math.max(existing?.openedAt ?? 0, project.openedAt),
        pinned: project.pinned ?? existing?.pinned,
      });
    }
    for (const project of collectSessionProjects(sessions)) {
      const key = normalizeProjectPath(project.path);
      if (!key) continue;
      const existing = byPath.get(key);
      byPath.set(key, {
        path: existing?.path ?? project.path,
        name: existing?.name ?? project.name,
        branch: existing?.branch,
        openedAt: Math.max(existing?.openedAt ?? 0, project.updatedAt),
        pinned: existing?.pinned,
        color: existing?.color ?? projectColor(project.path),
      });
    }
    if (workspace?.path) {
      const key = normalizeProjectPath(workspace.path);
      const existing = key ? byPath.get(key) : undefined;
      if (key) {
        byPath.set(key, {
          path: workspace.path,
          name: workspace.name || existing?.name || workspace.path,
          branch: workspace.branch || existing?.branch,
          openedAt: Math.max(existing?.openedAt ?? 0, Date.now()),
          pinned: existing?.pinned,
          color: existing?.color ?? projectColor(workspace.path),
        });
      }
    }
    const merged = [...byPath.values()].map((project) => {
      const meta = projectMeta[normalizeProjectPath(project.path) || project.path] ?? {};
      return {
        ...project,
        pinned: meta.pinned ?? project.pinned,
        archived: meta.archived === true,
      };
    });
    return merged.sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        b.openedAt - a.openedAt ||
        a.path.localeCompare(b.path),
    );
  }, [durableProjects, recents, sessions, workspace, projectMeta]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (p.branch || "").toLowerCase().includes(q) ||
        sessions.some(
          (session) =>
            sessionMatchesProject(session, p.path) && sessionMatchesQuery(session, q),
        ),
    );
  }, [items, query, sessions]);

  const locale = i18n.resolvedLanguage || i18n.language;

  // One pass derives the summary counters and the rendered sections together, so
  // the header totals can never disagree with the list below them.
  const { groups, sessionCounts } = useMemo(() => {
    const buckets: Record<GroupId, typeof filtered> = {
      pinned: [],
      projects: [],
      archived: [],
    };
    const counts = new Map<string, number>();
    for (const project of items) {
      let matched = 0;
      for (const session of sessions) {
        if (sessionMatchesProject(session, project.path)) matched += 1;
      }
      counts.set(project.path, matched);
    }
    for (const project of filtered) {
      const bucket: GroupId =
        project.archived === true ? "archived" : project.pinned ? "pinned" : "projects";
      buckets[bucket].push(project);
    }
    const byRecency = (a: (typeof filtered)[number], b: (typeof filtered)[number]) =>
      b.openedAt - a.openedAt || a.path.localeCompare(b.path);
    const byName = (a: (typeof filtered)[number], b: (typeof filtered)[number]) =>
      a.name.localeCompare(b.name, locale || undefined) ||
      a.path.localeCompare(b.path);
    for (const id of GROUP_ORDER) buckets[id].sort(sort === "name" ? byName : byRecency);
    return {
      groups: GROUP_ORDER.map((id) => ({ id, rows: buckets[id] })).filter(
        (group) => group.rows.length > 0,
      ),
      sessionCounts: counts,
    };
  }, [filtered, items, locale, sessions, sort]);

  const activate = async (path: string): Promise<boolean> => {
    try {
      const key = normalizeProjectPath(path);
      const archived = Boolean(key && projectMeta[key]?.archived);
      if (normalizeProjectPath(workspace?.path) === normalizeProjectPath(path)) {
        if (archived) restoreProject(path);
        setPage("chat");
        return true;
      }
      const activated = await activateProject(path);
      if (!activated) {
        showToast(t("project.none"), { variant: "error" });
        return false;
      }
      if (archived) restoreProject(path);
      setRecents(loadRecentProjects());
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
      return false;
    }
  };

  const startTask = async (path: string) => {
    try {
      const key = normalizeProjectPath(path);
      if (key && projectMeta[key]?.archived) restoreProject(path);
      await newSession({ projectPath: path });
      setRecents(loadRecentProjects());
      setPage("chat");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const openProjectSession = async (path: string, sessionId: string) => {
    if (!(await activate(path))) return;
    if (
      normalizeProjectPath(useAppStore.getState().workspace?.path) !==
      normalizeProjectPath(path)
    ) {
      return;
    }
    try {
      await selectSession(sessionId);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const toggleProjectArchive = async (project: (typeof items)[number]) => {
    setMenuFor(null);
    if (project.archived) {
      restoreProject(project.path);
      return;
    }
    try {
      const projectKey = normalizeProjectPath(project.path);
      const isActive = normalizeProjectPath(workspace?.path) === projectKey;
      if (isActive) {
        const fallbackPath = [...openProjectPaths]
          .reverse()
          .find((path) => {
            const key = normalizeProjectPath(path);
            return key !== projectKey && !(key && projectMeta[key]?.archived);
          });
        if (fallbackPath) {
          const activated = await activateProject(fallbackPath);
          if (!activated) throw new Error(t("project.none"));
          // Project management actions should keep the archive visible.
          setSettingsTab("projects");
        } else {
          await clearProject();
        }
      }
      archiveProject(project.path);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const closeProjectFromIndex = async (path: string) => {
    try {
      await closeProject(path);
      setSettingsTab("projects");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const addProject = () =>
    void openProject().then(() => setRecents(loadRecentProjects()));

  const searching = query.trim().length > 0;
  return (
    <div className="settings-stack settings-project-archive">
      <div className="projects-intro">
        <p className="projects-intro-desc">{t("project.archiveSubtitle")}</p>
      </div>

      <div className="projects-toolbar">
        <div
          className="settings-segment projects-sort"
          role="group"
          aria-label={t("project.sortBy")}
        >
          {(["recent", "name"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={cx(
                "settings-segment-item",
                "projects-sort-btn",
                sort === mode && "active",
              )}
              aria-pressed={sort === mode}
              onClick={() => setSort(mode)}
            >
              {t(mode === "recent" ? "project.sortRecent" : "project.sortName")}
            </button>
          ))}
        </div>
        <div className="projects-search-wrap">
          <IconSearch size={13} aria-hidden="true" />
          <input
            ref={searchRef}
            className="projects-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder={t("project.searchPlaceholder")}
            aria-label={t("project.searchPlaceholder")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          {searching ? (
            <button
              type="button"
              className="projects-search-clear"
              aria-label={t("project.clearSearch")}
              title={t("project.clearSearch")}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <IconX size={12} />
            </button>
          ) : null}
        </div>
        {searching ? (
          <span className="projects-result-count" aria-live="polite">
            {t("project.resultCount", {
              count: filtered.length,
              total: items.length,
            })}
          </span>
        ) : null}
        <div className="projects-toolbar-actions">
          <Button variant="primary" onClick={addProject}>
            <IconPlus size={14} />
            {t("project.add")}
          </Button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="settings-panel projects-empty">
          <span className="projects-empty-icon" aria-hidden>
            <IconArchive size={18} />
          </span>
          <div className="projects-empty-title">
            {items.length === 0 ? t("project.noProjects") : t("project.noSearchResults")}
          </div>
          <div className="projects-empty-body">
            {items.length === 0
              ? t("project.emptyIndexBody")
              : t("project.noSearchResultsBody")}
          </div>
          {items.length === 0 ? (
            <Button variant="primary" onClick={addProject}>
              <IconPlus size={14} />
              {t("project.add")}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setQuery("")}>
              {t("project.clearSearch")}
            </Button>
          )}
        </div>
      ) : (
        <div className="settings-panel projects-list">
          {groups.map((group) => (
            <section key={group.id} className="projects-group" aria-labelledby={`projects-group-${group.id}`}>
              <div className="projects-group-head">
                <h3 className="projects-group-label" id={`projects-group-${group.id}`}>
                  {t(GROUP_LABEL_KEYS[group.id])}
                </h3>
                <span className="projects-group-count">{group.rows.length}</span>
              </div>
              <div className="projects-group-rows" role="list">
              {group.rows.map((project) => {
                const active =
                  normalizeProjectPath(workspace?.path) ===
                  normalizeProjectPath(project.path);
                const archived = project.archived === true;
                const retained = openProjectPaths.some(
                  (path) =>
                    normalizeProjectPath(path) === normalizeProjectPath(project.path),
                );
                const color = project.color || projectColor(project.path);
                const projectMatchesQuery =
                  !query.trim() ||
                  project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ||
                  project.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ||
                  (project.branch || "")
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase());
                const related = sessions
                  .filter((session) => sessionMatchesProject(session, project.path))
                  .sort(
                    (a, b) =>
                      sessionTimestamp(b.updatedAt) - sessionTimestamp(a.updatedAt) ||
                      sessionTimestamp(b.createdAt) - sessionTimestamp(a.createdAt) ||
                      a.title.localeCompare(b.title) ||
                      a.id.localeCompare(b.id),
                  );
                const matchingSessions = related.filter((session) =>
                  sessionMatchesQuery(session, query),
                );
                const sessionSearchMatch = !projectMatchesQuery && matchingSessions.length > 0;
                const isOpen = !!expanded[project.path] || sessionSearchMatch;
                const displayedSessions = sessionSearchMatch ? matchingSessions : related;
                const visibleCount =
                  visibleSessionCounts[project.path] ?? INITIAL_VISIBLE_SESSION_COUNT;
                const visibleSessions = displayedSessions.slice(0, visibleCount);
                const hiddenSessionCount = displayedSessions.length - visibleSessions.length;
                const totalSessions = sessionCounts.get(project.path) ?? related.length;
                const menuOpen = menuFor === project.path;
                return (
                  <div
                    key={project.path}
                    role="listitem"
                    className={cx(
                      "projects-row-block",
                      active && "active",
                      archived && "archived",
                      isOpen && "expanded",
                      menuOpen && "menu-open",
                    )}
                  >
                    <div className="projects-row">
                      <button
                        type="button"
                        className="projects-expand"
                        aria-label={t(
                          isOpen ? "project.collapseDetails" : "project.expandDetails",
                          { name: project.name },
                        )}
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpanded((prev) => ({
                            ...prev,
                            [project.path]: !prev[project.path],
                          }))
                        }
                      >
                        {isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                      </button>
                      <button
                        type="button"
                        className="projects-name-btn"
                        onClick={() => void activate(project.path)}
                        title={project.path}
                      >
                        <span className="projects-glyph" style={{ background: color }}>
                          {project.pinned ? (
                            <IconStar size={15} fill="currentColor" aria-hidden />
                          ) : (
                            <IconFolder size={15} aria-hidden />
                          )}
                        </span>
                        <span className="projects-name-copy">
                          <span className="projects-name-title">
                            <span className="projects-name-text">{project.name}</span>
                            {active ? (
                              <span className="projects-tag is-active">
                                {t("project.active")}
                              </span>
                            ) : retained ? (
                              <span className="projects-tag">{t("project.openTag")}</span>
                            ) : null}
                            {project.pinned ? (
                              <span
                                className="projects-tag is-pin"
                                title={t("project.pinnedTag")}
                                aria-label={t("project.pinnedTag")}
                              >
                                <IconPin size={10} />
                              </span>
                            ) : null}
                            {archived ? (
                              <span className="projects-tag is-archived">
                                {t("project.archivedTag")}
                              </span>
                            ) : null}
                          </span>
                          <span className="projects-name-meta">
                            <span className="projects-name-path">
                              {shortenPath(project.path)}
                            </span>
                            {project.branch ? (
                              <>
                                <span className="projects-meta-dot" aria-hidden>
                                  ·
                                </span>
                                <span className="projects-name-branch">{project.branch}</span>
                              </>
                            ) : null}
                            <span className="projects-meta-dot" aria-hidden>
                              ·
                            </span>
                            <span className="projects-name-sessions">
                              {t("project.sessionsCount", { count: totalSessions })}
                            </span>
                          </span>
                        </span>
                      </button>
                      <span className="projects-updated">
                        {formatUpdated(project.openedAt, locale, t("project.updatedNever"))}
                      </span>
                      <div className="projects-row-actions">
                        <button
                          type="button"
                          className="projects-icon-btn"
                          aria-label={t("project.newTask")}
                          title={t("project.newTask")}
                          onClick={() => void startTask(project.path)}
                        >
                          <IconPlus size={15} />
                        </button>
                        <div
                          className="projects-menu-wrap"
                          ref={menuOpen ? menuRef : undefined}
                        >
                          <button
                            type="button"
                            className="projects-icon-btn"
                            aria-label={t("project.openActions", { name: project.name })}
                            title={t("project.openActions", { name: project.name })}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() =>
                              setMenuFor((cur) => (cur === project.path ? null : project.path))
                            }
                          >
                            <IconMore size={16} />
                          </button>
                          {menuOpen ? (
                            <div className="projects-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuFor(null);
                                  void startTask(project.path);
                                }}
                              >
                                <IconChat size={14} />
                                {t("project.newTask")}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuFor(null);
                                  setInstructionsFor({
                                    name: project.name,
                                    path: project.path,
                                  });
                                }}
                              >
                                <IconFileText size={14} />
                                {t("project.editInstructions")}
                              </button>
                              <div className="projects-menu-sep" role="separator" />
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  toggleProjectPinned(project.path, !project.pinned);
                                  setMenuFor(null);
                                }}
                              >
                                <IconPin size={14} />
                                {project.pinned ? t("project.unpin") : t("project.pin")}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void toggleProjectArchive(project)}
                              >
                                {archived ? (
                                  <IconArchiveRestore size={14} />
                                ) : (
                                  <IconArchive size={14} />
                                )}
                                {archived ? t("project.restore") : t("project.archive")}
                              </button>
                              {retained ? (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={() => {
                                    setMenuFor(null);
                                    void closeProjectFromIndex(project.path);
                                  }}
                                >
                                  <IconX size={14} />
                                  {t("project.close")}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {isOpen ? (
                      <div className="projects-row-detail">
                        <div className="projects-detail-header">
                          <div className="projects-detail-label">
                            {t("project.sessionsCount", { count: displayedSessions.length })}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="projects-detail-new"
                            onClick={() => void startTask(project.path)}
                          >
                            <IconPlus size={13} />
                            {t("project.newTask")}
                          </Button>
                        </div>
                        {displayedSessions.length === 0 ? (
                          <div className="projects-detail-empty">{t("project.noSessions")}</div>
                        ) : (
                          <div className="projects-detail-tasks">
                            {visibleSessions.map((s) => {
                              const title = s.title || s.id;
                              return (
                                <div
                                  key={s.id}
                                  className="projects-detail-task-row"
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    setRenameFor(s);
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="projects-detail-task"
                                    onClick={() => void openProjectSession(project.path, s.id)}
                                    title={title}
                                  >
                                    <IconChat size={13} className="projects-detail-task-icon" />
                                    <span className="projects-detail-task-title">{title}</span>
                                    <span className="projects-detail-task-updated">
                                      {formatUpdated(
                                        sessionTimestamp(s.updatedAt),
                                        locale,
                                        t("project.updatedNever"),
                                      )}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    className="projects-detail-task-rename"
                                    aria-label={t("session.renameAction", { title })}
                                    title={t("session.renameAction", { title })}
                                    onClick={() => setRenameFor(s)}
                                  >
                                    <IconPencil size={13} aria-hidden />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {hiddenSessionCount > 0 ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="projects-detail-more"
                            onClick={() =>
                              setVisibleSessionCounts((prev) => ({
                                ...prev,
                                [project.path]: visibleCount + INITIAL_VISIBLE_SESSION_COUNT,
                              }))
                            }
                          >
                            {t("project.showMoreSessions", { count: hiddenSessionCount })}
                          </Button>
                        ) : displayedSessions.length > INITIAL_VISIBLE_SESSION_COUNT ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="projects-detail-more"
                            onClick={() =>
                              setVisibleSessionCounts((prev) => ({
                                ...prev,
                                [project.path]: INITIAL_VISIBLE_SESSION_COUNT,
                              }))
                            }
                          >
                            {t("project.showFewerSessions")}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              </div>
            </section>
          ))}
        </div>
      )}
      {instructionsFor ? (
        <ProjectInstructionsDialog
          project={instructionsFor}
          onClose={() => setInstructionsFor(null)}
          onSaved={() => showToast(t("project.instructionsSaved"), { variant: "success" })}
          onError={(error) =>
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            })
          }
        />
      ) : null}
      {renameFor ? (
        <SessionRenameDialog
          session={renameFor}
          onClose={() => setRenameFor(null)}
          onSave={(title) => renameSession(renameFor.id, title)}
          onError={(error) =>
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            })
          }
        />
      ) : null}
    </div>
  );
}
