import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { ErrorCodes } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { Button, TooltipButton, cx } from "../components/ui";
import {
  IconArchive,
  IconArchiveRestore,
  IconChat,
  IconFileText,
  IconMore,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconX,
} from "../components/icons";
import { loadRecentProjects, type RecentProject } from "../lib/recent-projects";
import { collectSessionProjects } from "../lib/session-projects";
import { normalizeProjectPath } from "../lib/sidebar-session-groups";
import { ProjectInstructionsDialog } from "../components/ProjectInstructionsDialog";
import { ProjectMemoryDialog } from "../components/ProjectMemoryDialog";
import { ProjectEditDialog } from "../components/ProjectEditDialog";
import { ProjectDeleteDialog } from "../components/ProjectDeleteDialog";
import { SessionRenameDialog } from "../components/SessionRenameDialog";
import { useArmedDelete } from "../hooks/use-armed-delete";
import { AnchoredMenu } from "../components/settings/AnchoredMenu";
import {
  INITIAL_VISIBLE_SESSION_COUNT,
  buildProjectIndex,
  countProjectSessions,
  displayedProjectSessions,
  filterArchiveItems,
  groupArchiveRows,
  neighborPath,
  nextArchiveOpenPath,
  sessionMatchesIndexProject,
  type ProjectIndexItem,
  type SessionIndexRecord,
  type SortMode,
} from "../lib/project-archive";
import { ProjectArchiveIndex, projectRowId } from "../features/projects/ProjectArchiveIndex";
import { ProjectDetailPanel } from "../features/projects/ProjectDetailPanel";

export function ProjectsPage() {
  const { t, i18n } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const openProjectPaths = useAppStore((s) => s.openProjectPaths);
  const projectMeta = useAppStore((s) => s.projectMeta);
  const openProject = useAppStore((s) => s.openProject);
  const activateProject = useAppStore((s) => s.activateProject);
  const clearProject = useAppStore((s) => s.clearProject);
  const closeProject = useAppStore((s) => s.closeProject);
  const renameProject = useAppStore((s) => s.renameProject);
  const toggleProjectPinned = useAppStore((s) => s.toggleProjectPinned);
  const archiveProject = useAppStore((s) => s.archiveProject);
  const deleteProjectAction = useAppStore((s) => s.deleteProject);
  const restoreProject = useAppStore((s) => s.restoreProject);
  const newSession = useAppStore((s) => s.newSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const renameSession = useAppStore((s) => s.renameSession);
  const sessions = useAppStore((s) => s.sessions);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const showToast = useAppStore((s) => s.showToast);
  const [recents, setRecents] = useState<RecentProject[]>(() => loadRecentProjects());
  const [durableProjects, setDurableProjects] = useState<ProjectGroupRecord[]>([]);
  // The host listing is the slow half of the index; until it settles an empty
  // index means "not loaded yet" rather than "no projects".
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  // The row whose card is open. Closed until the user asks for one.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<Record<string, number>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Which row menu item is armed for its second, confirming click.
  const { armed: armedDelete, setArmed: setArmedDelete } = useArmedDelete();
  const [renameFor, setRenameFor] = useState<SessionIndexRecord | null>(null);
  const [editProjectFor, setEditProjectFor] = useState<{
    path: string;
    name: string;
    groupId?: string;
    roots?: ProjectGroupRecord["roots"];
    legacy?: boolean;
  } | null>(null);
  // `roots` rides along so the dialog can keep deriving the project's live
  // running sessions while it is open, instead of a snapshot taken on click.
  const [deleteFor, setDeleteFor] = useState<{
    name: string;
    path: string;
    sessionCount: number;
    roots: ProjectGroupRecord["roots"];
  } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [instructionsFor, setInstructionsFor] = useState<{
    name: string;
    path: string;
    groupId?: string;
    legacy?: boolean;
  } | null>(null);
  const [memoryFor, setMemoryFor] = useState<{
    name: string;
    path: string;
    groupId?: string;
    legacy?: boolean;
  } | null>(null);

  useEffect(() => {
    let canceled = false;
    void api
      .listProjectGroups()
      .then(({ groups }) => {
        if (!canceled) setDurableProjects(groups);
      })
      .catch(() => {
        // Session-derived entries below keep the index useful if host listing fails.
      })
      .finally(() => {
        if (!canceled) setLoadingProjects(false);
      });
    return () => {
      canceled = true;
    };
  }, [sessions]);

  const items = useMemo(
    () =>
      buildProjectIndex({
        durableProjects,
        recents,
        sessionProjects: collectSessionProjects(sessions),
        workspace,
        projectMeta,
      }),
    [durableProjects, recents, sessions, workspace, projectMeta],
  );

  const filtered = useMemo(
    () => filterArchiveItems(items, sessions, query),
    [items, query, sessions],
  );

  const locale = i18n.resolvedLanguage || i18n.language;

  // One pass derives the summary counters and the rendered sections together, so
  // the header totals can never disagree with the list below them.
  const { groups, sessionCounts } = useMemo(
    () => ({
      groups: groupArchiveRows(filtered, sort, locale),
      sessionCounts: countProjectSessions(items, sessions),
    }),
    [filtered, items, locale, sessions, sort],
  );

  // The order the user sees: section order with each section's active sort
  // already applied, which is what the arrow keys must follow.
  const renderedRows = useMemo(
    () => groups.flatMap((group) => group.rows),
    [groups],
  );

  // An open card cannot outlive its row: a search that no longer matches the
  // project drops it from the list, and the card closes with it.
  useEffect(() => {
    if (openPath && !filtered.some((item) => item.path === openPath)) {
      setOpenPath(null);
    }
  }, [filtered, openPath]);

  const project = filtered.find((item) => item.path === openPath) ?? null;
  const selectedSessions = project
    ? displayedProjectSessions(sessions, project, query)
    : { related: [] as SessionIndexRecord[], displayed: [] as SessionIndexRecord[], sessionSearchMatch: false };

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
      if (useAppStore.getState().sessionMeta[sessionId]?.archived === true) {
        restoreSession(sessionId);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  /** Menu items of different surfaces never share an armed key. */
  const projectDeleteKey = (path: string) => `project:${normalizeProjectPath(path)}`;

  /**
   * Two-step delete for an index row. The first click arms the menu item and
   * relabels it; the second deletes an idle project straight away. A project
   * with a live turn keeps the dialog that names those sessions and stops them
   * before the delete.
   */
  const requestDeleteProject = async (project: ProjectIndexItem, totalSessions: number) => {
    const key = projectDeleteKey(project.path);
    if (armedDelete !== key) {
      setArmedDelete(key);
      return;
    }
    setArmedDelete(null);
    setMenuFor(null);
    const liveSessions = sessions.filter(
      (session) =>
        sessionMatchesIndexProject(session, project) && runningSessions[session.id] === true,
    );
    if (liveSessions.length > 0) {
      setDeleteFor({
        name: project.name,
        path: project.path,
        sessionCount: totalSessions,
        roots: project.roots,
      });
      return;
    }
    try {
      await deleteProjectAction(project.path);
      setRecents(loadRecentProjects());
      showToast(t("project.deleted", { name: project.name }), { variant: "success" });
    } catch (error) {
      // The host refuses a project whose task started after this render.
      showToast(
        (error as { errorCode?: unknown } | null)?.errorCode === ErrorCodes.CONFLICT
          ? t("project.deleteRunningBlocked")
          : error instanceof Error
            ? error.message
            : String(error),
        { variant: "error" },
      );
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
  const displayedSessions = selectedSessions.displayed;
  const visibleCount =
    (project ? visibleSessionCounts[project.path] : undefined) ??
    INITIAL_VISIBLE_SESSION_COUNT;
  const visibleSessions = displayedSessions.slice(0, visibleCount);
  const hiddenSessionCount = displayedSessions.length - visibleSessions.length;
  const totalSessions = project
    ? (sessionCounts.get(project.path) ?? selectedSessions.related.length)
    : 0;
  const menuOpen = Boolean(project && menuFor === project.path);
  const selectedActive =
    project != null &&
    normalizeProjectPath(workspace?.path) === normalizeProjectPath(project.path);
  const selectedRetained =
    project != null &&
    openProjectPaths.some(
      (path) => normalizeProjectPath(path) === normalizeProjectPath(project.path),
    );
  const selectedArchived = project?.archived === true;

  /*
    The index is one selectable list, so the arrow keys walk it and Enter takes
    the chat path. Selection moves real focus with it, otherwise the next arrow
    key would keep firing from wherever the user last clicked.

    Two bounds keep the handler from stealing its own children's keys. It walks
    the rows in rendered order — the section order and the active sort, not the
    index build order — and it stays out of the open card entirely, so Enter on
    a session row or the overflow trigger stays that control's own action
    instead of being answered as "activate this project".
  */
  const onIndexKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".projects-inspector")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = neighborPath(
        renderedRows,
        openPath,
        event.key === "ArrowDown" ? 1 : -1,
      );
      if (!next || next === openPath) return;
      setOpenPath(next);
      setMenuFor(null);
      document
        .getElementById(projectRowId(next))
        ?.querySelector<HTMLButtonElement>(".projects-row")
        ?.focus();
      return;
    }
    if (event.key === "Enter" && openPath) {
      event.preventDefault();
      void activate(openPath);
    }
  };

  return (
    <div className="settings-stack">
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
          <IconSearch size={14} aria-hidden="true" />
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
            <TooltipButton
              type="button"
              className="projects-search-clear"
              tooltip={t("project.clearSearch")}
              ariaLabel={t("project.clearSearch")}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <IconX size={12} />
            </TooltipButton>
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
            {items.length === 0 && loadingProjects ? (
              <span className="route-pending-indicator" />
            ) : (
              <IconArchive size={18} />
            )}
          </span>
          <div className="projects-empty-title">
            {items.length === 0 && loadingProjects
              ? t("common.loading")
              : items.length === 0
                ? t("project.noProjects")
                : t("project.noSearchResults")}
          </div>
          {/* A pending host listing must not silence the hint for the one
              case that still has rows to talk about: a query that matched
              nothing. */}
          {items.length === 0 ? null : (
            <div className="projects-empty-body">{t("project.noSearchResultsBody")}</div>
          )}
          {items.length === 0 && loadingProjects ? null : items.length === 0 ? (
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
        <div className="projects-workbench" tabIndex={0} onKeyDown={onIndexKeyDown}>
          <ProjectArchiveIndex
            groups={groups}
            openPath={openPath}
            workspacePath={workspace?.path}
            openProjectPaths={openProjectPaths}
            locale={locale}
            sessionCounts={sessionCounts}
            onSelect={(path) => {
              setOpenPath((current) => nextArchiveOpenPath(current, path));
              setMenuFor(null);
            }}
            onActivate={(path) => void activate(path)}
            detail={
              project ? (
                <ProjectDetailPanel
                  project={project}
                  sessions={visibleSessions}
                  displayedCount={displayedSessions.length}
                  hiddenCount={hiddenSessionCount}
                  initialCount={INITIAL_VISIBLE_SESSION_COUNT}
                  locale={locale}
                  onOpenSession={(sessionId) =>
                    void openProjectSession(project.path, sessionId)
                  }
                  onNewTask={() => void startTask(project.path)}
                  onRenameSession={setRenameFor}
                  onShowMore={() =>
                    setVisibleSessionCounts((prev) => ({
                      ...prev,
                      [project.path]: visibleCount + INITIAL_VISIBLE_SESSION_COUNT,
                    }))
                  }
                  onShowLess={() =>
                    setVisibleSessionCounts((prev) => ({
                      ...prev,
                      [project.path]: INITIAL_VISIBLE_SESSION_COUNT,
                    }))
                  }
                  actions={
                    <>
                      {selectedActive ? null : (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => void activate(project.path)}
                        >
                          {t("project.open")}
                        </Button>
                      )}
                      <AnchoredMenu
                        className="projects-menu-wrap"
                        open={menuOpen}
                        onClose={() => setMenuFor(null)}
                        menuClassName="projects-menu"
                        label={t("project.openActions", { name: project.name })}
                        role="menu"
                        align="end"
                        trigger={(ref) => (
                          <TooltipButton
                            ref={ref}
                            type="button"
                            className="projects-icon-btn"
                            tooltip={t("project.openActions", { name: project.name })}
                            ariaLabel={t("project.openActions", { name: project.name })}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() =>
                              setMenuFor((cur) => (cur === project.path ? null : project.path))
                            }
                          >
                            <IconMore size={16} />
                          </TooltipButton>
                        )}
                      >
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
                              groupId: project.groupId,
                              legacy: project.legacy,
                            });
                          }}
                        >
                          <IconFileText size={14} />
                          {t("project.editInstructions")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuFor(null);
                            setMemoryFor({
                              name: project.name,
                              path: project.path,
                              groupId: project.groupId,
                              legacy: project.legacy,
                            });
                          }}
                        >
                          <IconSparkles size={14} />
                          {t("project.editMemory")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-action="edit-project"
                          onClick={() => {
                            setMenuFor(null);
                            setEditProjectFor({
                              path: project.path,
                              name: project.name,
                              groupId: project.groupId,
                              roots: project.roots,
                              legacy: project.legacy,
                            });
                          }}
                        >
                          <IconPencil size={14} />
                          {t("project.edit", { defaultValue: "Edit project" })}
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
                          {selectedArchived ? (
                            <IconArchiveRestore size={14} />
                          ) : (
                            <IconArchive size={14} />
                          )}
                          {selectedArchived ? t("project.restore") : t("project.archive")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className={cx(
                            "danger",
                            armedDelete === projectDeleteKey(project.path) && "is-armed",
                          )}
                          data-action="delete-project"
                          data-armed={
                            armedDelete === projectDeleteKey(project.path) ? "true" : undefined
                          }
                          onClick={() => void requestDeleteProject(project, totalSessions)}
                        >
                          <IconTrash size={14} />
                          {armedDelete === projectDeleteKey(project.path)
                            ? t("project.deleteMenuConfirm")
                            : t("project.delete")}
                        </button>
                        {selectedRetained ? (
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
                      </AnchoredMenu>
                    </>
                  }
                />
              ) : null
            }
          />
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
      {memoryFor ? (
        <ProjectMemoryDialog
          project={memoryFor}
          onClose={() => setMemoryFor(null)}
          onSaved={() => showToast(t("project.memorySaved"), { variant: "success" })}
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
      {editProjectFor ? (
        <ProjectEditDialog
          project={editProjectFor}
          onClose={() => setEditProjectFor(null)}
          onSaved={(group) => {
            renameProject(group.primaryPath, group.name);
            setDurableProjects((current) =>
              current.map((item) =>
                item.id === group.id || item.id === editProjectFor.groupId ? group : item,
              ),
            );
          }}
          onError={(error) =>
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            })
          }
        />
      ) : null}
      {deleteFor ? (
        <ProjectDeleteDialog
          project={deleteFor}
          runningSessionIds={sessions
            .filter(
              (session) =>
                sessionMatchesIndexProject(session, deleteFor) &&
                runningSessions[session.id] === true,
            )
            .map((session) => session.id)}
          onClose={() => setDeleteFor(null)}
          onDeleted={() => {
            setDeleteFor(null);
            setRecents(loadRecentProjects());
            showToast(t("project.deleted", { name: deleteFor.name }), { variant: "success" });
          }}
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
