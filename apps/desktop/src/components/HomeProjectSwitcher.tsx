import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { parseGitCloneUrl } from "../lib/git-clone-url";
import {
  filterSwitcherProjects,
  listSwitcherProjects,
  normalizeProjectPath,
} from "../lib/sidebar-preferences";
import { useAppStore } from "../stores/app-store";
import {
  IconBranch,
  IconCheck,
  IconChevronLeft,
  IconFolder,
  IconNewProject,
  IconSearch,
} from "./icons";
import { AnchoredMenu } from "./settings/AnchoredMenu";
import { cx } from "./ui";

export function HomeProjectSwitcher({
  name,
  path,
}: {
  name: string;
  path?: string | null;
}) {
  const { t } = useTranslation();
  const openProjectPaths = useAppStore((state) => state.openProjectPaths);
  const openProjects = useAppStore((state) => state.openProjects);
  const workspace = useAppStore((state) => state.workspace);
  const projectMeta = useAppStore((state) => state.projectMeta);
  const projectSort = useAppStore((state) => state.projectSort);
  const activeProjectPath = useAppStore((state) => state.activeProjectPath);
  const newSession = useAppStore((state) => state.newSession);
  const openProject = useAppStore((state) => state.openProject);
  const cloneProject = useAppStore((state) => state.cloneProject);
  const showToast = useAppStore((state) => state.showToast);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "clone">("list");
  const [query, setQuery] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);

  const projects = useMemo(
    () =>
      listSwitcherProjects({
        openProjectPaths,
        openProjects,
        workspace,
        projectMeta,
        projectSort,
      }),
    [openProjectPaths, openProjects, workspace, projectMeta, projectSort],
  );
  const visible = useMemo(
    () => filterSwitcherProjects(projects, query),
    [projects, query],
  );
  const activeKey = normalizeProjectPath(activeProjectPath ?? path);
  const cloneTarget = parseGitCloneUrl(cloneUrl);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setView("list");
    setCloneUrl("");
  }, []);

  const reportError = useCallback(
    (error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    },
    [showToast],
  );

  const selectProject = useCallback(
    async (nextPath: string) => {
      if (busy) return;
      const nextKey = normalizeProjectPath(nextPath);
      close();
      if (!nextKey || nextKey === activeKey) return;
      setBusy(true);
      try {
        await newSession({ projectPath: nextPath });
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(false);
      }
    },
    [activeKey, busy, close, newSession, reportError],
  );

  const startClone = useCallback(async () => {
    if (busy || !cloneTarget) return;
    setBusy(true);
    try {
      const previous = normalizeProjectPath(
        useAppStore.getState().workspace?.path,
      );
      const workspace = await cloneProject(cloneTarget.url);
      if (!workspace?.path) return;
      close();
      const nextKey = normalizeProjectPath(workspace.path);
      if (nextKey && nextKey !== previous) {
        await newSession({ projectPath: workspace.path });
      }
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }, [busy, cloneProject, cloneTarget, close, newSession, reportError]);

  const pickFolder = useCallback(async () => {
    if (busy) return;
    close();
    setBusy(true);
    try {
      const previous = normalizeProjectPath(
        useAppStore.getState().workspace?.path,
      );
      await openProject();
      const nextPath = useAppStore.getState().workspace?.path;
      const nextKey = normalizeProjectPath(nextPath);
      if (nextPath && nextKey && nextKey !== previous) {
        await newSession({ projectPath: nextPath });
      }
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }, [busy, close, newSession, openProject, reportError]);

  useEffect(() => {
    if (!open) return;
    const current = visible.findIndex((project) => project.key === activeKey);
    setHighlight(current >= 0 ? current : 0);
  }, [activeKey, open, visible]);

  useEffect(() => {
    if (!open || view !== "list") return;
    document
      .querySelector<HTMLElement>(`[data-switcher-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, open, view]);

  const moveHighlight = (delta: number) => {
    if (visible.length === 0) return;
    setHighlight(
      (current) => (current + delta + visible.length) % visible.length,
    );
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (view === "clone") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter") {
      const target = visible[highlight];
      if (!target) return;
      event.preventDefault();
      void selectProject(target.path);
    }
  };

  return (
    <AnchoredMenu
      className="home-project-switcher"
      open={open}
      onClose={close}
      menuClassName="home-project-switcher-menu"
      label={t("project.switchProject")}
      role="menu"
      align="start"
      side="bottom"
      initialFocus="input"
      onMenuKeyDown={onMenuKeyDown}
      trigger={(ref) => (
        <button
          ref={ref}
          type="button"
          className="project-underline"
          data-testid="home-project-switcher"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${t("project.switchProject")}: ${name}`}
          title={path || t("project.switchProject")}
          disabled={busy}
          onClick={() => {
            if (open) {
              close();
              return;
            }
            setQuery("");
            setView("list");
            setCloneUrl("");
            setOpen(true);
          }}
        >
          {name}
        </button>
      )}
    >
      {view === "clone" ? (
        <div className="home-project-switcher-clone">
          <button
            type="button"
            className="home-project-switcher-item"
            disabled={busy}
            onClick={() => setView("list")}
          >
            <IconChevronLeft size={14} aria-hidden />
            <span className="home-project-switcher-item-name">
              {t("project.clone")}
            </span>
          </button>
          <label className="home-project-switcher-search">
            <IconBranch size={13} aria-hidden />
            <span className="sr-only">{t("project.cloneUrlPlaceholder")}</span>
            <input
              type="text"
              value={cloneUrl}
              placeholder={t("project.cloneUrlPlaceholder")}
              aria-label={t("project.cloneUrlPlaceholder")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setCloneUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void startClone();
                }
              }}
            />
          </label>
          <p className="home-project-switcher-clone-hint">
            {cloneTarget
              ? t("project.cloneDestHint", { name: cloneTarget.name })
              : t("project.cloneUrlHint")}
          </p>
          <button
            type="button"
            className="home-project-switcher-clone-submit"
            disabled={busy || !cloneTarget}
            onClick={() => void startClone()}
          >
            {busy ? t("project.cloning") : t("project.cloneAction")}
          </button>
        </div>
      ) : (
        <>
          <label className="home-project-switcher-search">
            <IconSearch size={13} aria-hidden />
            <span className="sr-only">{t("project.searchPlaceholder")}</span>
            <input
              type="text"
              value={query}
              placeholder={t("project.searchPlaceholder")}
              aria-label={t("project.searchPlaceholder")}
              aria-controls="home-project-switcher-list"
              aria-activedescendant={
                visible[highlight]
                  ? `home-project-switcher-option-${highlight}`
                  : undefined
              }
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div
            className="home-project-switcher-list"
            id="home-project-switcher-list"
            role="none"
          >
            {visible.length === 0 ? (
              <div className="home-project-switcher-empty">
                {t("project.noSearchResults")}
              </div>
            ) : (
              visible.map((project, index) => {
                const current = project.key === activeKey;
                return (
                  <button
                    key={project.key}
                    id={`home-project-switcher-option-${index}`}
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={current}
                    data-switcher-index={index}
                    title={project.path}
                    className={cx(
                      "home-project-switcher-item",
                      current && "is-current",
                      highlight === index && "is-active",
                    )}
                    disabled={busy}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => void selectProject(project.path)}
                  >
                    <IconFolder size={14} aria-hidden />
                    <span className="home-project-switcher-item-name">
                      {project.name}
                    </span>
                    {current ? (
                      <IconCheck
                        size={14}
                        className="home-project-switcher-check"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="home-project-switcher-divider" aria-hidden />
          <button
            type="button"
            role="menuitem"
            className="home-project-switcher-item"
            disabled={busy}
            onClick={() => {
              setCloneUrl("");
              setView("clone");
            }}
          >
            <IconBranch size={14} aria-hidden />
            <span className="home-project-switcher-item-name">
              {t("project.clone")}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="home-project-switcher-item"
            disabled={busy}
            onClick={() => void pickFolder()}
          >
            <IconNewProject size={14} aria-hidden />
            <span className="home-project-switcher-item-name">
              {t("project.open")}
            </span>
          </button>
        </>
      )}
    </AnchoredMenu>
  );
}
