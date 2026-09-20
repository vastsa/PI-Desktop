import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton } from "../../components/ui";
import { IconBranch, IconChat, IconFolder, IconPencil, IconPlus } from "../../components/icons";
import {
  formatUpdated,
  sessionTimestamp,
  shortenPath,
  type ProjectIndexItem,
  type SessionIndexRecord,
} from "../../lib/project-archive";

/*
  The detail half of the selected project card. The selected row above already
  carries the name, the status tag, and the path, so this panel never repeats
  them: it opens with the action bar, then the read-only facts (folders and
  branch), then the sessions section. Actions arrive as a node because the
  anchored menu is owned by the page that holds the project state.
*/
export function ProjectDetailPanel({
  project,
  sessions,
  displayedCount,
  hiddenCount,
  initialCount,
  locale,
  actions,
  onOpenSession,
  onNewTask,
  onRenameSession,
  onShowMore,
  onShowLess,
}: {
  project: ProjectIndexItem;
  /** Already sliced to the visible batch. */
  sessions: readonly SessionIndexRecord[];
  /** Rows the session list is allowed to render (matches the section label). */
  displayedCount: number;
  hiddenCount: number;
  initialCount: number;
  locale?: string;
  actions?: ReactNode;
  onOpenSession: (sessionId: string) => void;
  onNewTask: () => void;
  onRenameSession: (session: SessionIndexRecord) => void;
  onShowMore: () => void;
  onShowLess: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="projects-detail-bar">
        <Button
          size="sm"
          variant="ghost"
          className="projects-detail-new"
          onClick={onNewTask}
        >
          <IconPlus size={13} />
          {t("project.newTask")}
        </Button>
        {actions}
      </div>

      <div className="projects-detail-facts">
        <div
          className="projects-detail-roots"
          role="group"
          aria-label={t("project.foldersLabel")}
        >
          {project.roots.map((root) => (
            <span className="projects-detail-root" key={root.path} title={root.path}>
              <IconFolder size={12} aria-hidden />
              <span>{shortenPath(root.path)}</span>
            </span>
          ))}
        </div>
        {project.branch ? (
          <span className="projects-detail-root is-branch" title={project.branch}>
            <IconBranch size={12} aria-hidden />
            <span>{project.branch}</span>
          </span>
        ) : null}
      </div>

      <div className="projects-detail-header">
        <div className="projects-detail-label">
          {t("project.sessionsCount", { count: displayedCount })}
        </div>
      </div>

      {displayedCount === 0 ? (
        <div className="projects-detail-empty">{t("project.noSessions")}</div>
      ) : (
        <div className="projects-detail-tasks">
          {sessions.map((session) => {
            const title = session.title || session.id;
            return (
              <div
                key={session.id}
                className="projects-detail-task-row"
                onContextMenu={(event) => {
                  event.preventDefault();
                  onRenameSession(session);
                }}
              >
                <button
                  type="button"
                  className="projects-detail-task"
                  onClick={() => onOpenSession(session.id)}
                  title={title}
                >
                  <IconChat size={13} className="projects-detail-task-icon" />
                  <span className="projects-detail-task-title">{title}</span>
                  <span className="projects-detail-task-updated">
                    {formatUpdated(
                      sessionTimestamp(session.updatedAt),
                      locale,
                      t("project.updatedNever"),
                    )}
                  </span>
                </button>
                <TooltipButton
                  type="button"
                  className="projects-detail-task-rename"
                  tooltip={t("session.renameAction", { title })}
                  ariaLabel={t("session.renameAction", { title })}
                  onClick={() => onRenameSession(session)}
                >
                  <IconPencil size={13} aria-hidden />
                </TooltipButton>
              </div>
            );
          })}
        </div>
      )}

      {hiddenCount > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          className="projects-detail-more"
          onClick={onShowMore}
        >
          {t("project.showMoreSessions", { count: hiddenCount })}
        </Button>
      ) : displayedCount > initialCount ? (
        <Button
          size="sm"
          variant="ghost"
          className="projects-detail-more"
          onClick={onShowLess}
        >
          {t("project.showFewerSessions")}
        </Button>
      ) : null}
    </>
  );
}
