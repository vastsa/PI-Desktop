import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../components/ui";
import { IconChevronRight, IconFolder, IconStar } from "../../components/icons";
import { projectColor } from "../../lib/recent-projects";
import {
  formatUpdated,
  GROUP_LABEL_KEYS,
  PROJECT_STATUS_LABEL_KEYS,
  projectStatus,
  shortenPath,
  type GroupId,
  type ProjectIndexItem,
} from "../../lib/project-archive";

/**
 * Row element id. Encoded rather than slugged: two projects whose paths differ
 * only in separators (`/w/api-server` vs `/w/api/server`) slugged to one id, so
 * `getElementById` returned whichever row came first in the document.
 */
export function projectRowId(path: string) {
  return `projects-row-${encodeURIComponent(path)}`;
}

/*
  The index is one inset grouped list in the iOS sense: a quiet section label,
  then rows that read left-to-right as identity (glyph, name, path) and
  right-to-left as detail (session count, last active, disclosure). Selecting a
  row expands its detail in place under the row, so the row itself is always the
  header of the open card and no name is ever repeated inside it (D455).
*/
export function ProjectArchiveIndex({
  groups,
  openPath,
  workspacePath,
  openProjectPaths,
  locale,
  sessionCounts,
  detail,
  onSelect,
  onActivate,
}: {
  groups: { id: GroupId; rows: ProjectIndexItem[] }[];
  /** Path whose card is open, or `null` while the index is only a list. */
  openPath: string | null;
  workspacePath?: string | null;
  openProjectPaths: readonly string[];
  locale?: string;
  sessionCounts: Map<string, number>;
  detail?: ReactNode;
  onSelect: (path: string) => void;
  onActivate: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="projects-index">
      {groups.map((group) => (
        <section
          key={group.id}
          className="projects-group"
          aria-labelledby={`projects-group-${group.id}`}
        >
          <div className="projects-group-head">
            <h3 className="projects-group-label" id={`projects-group-${group.id}`}>
              {t(GROUP_LABEL_KEYS[group.id])}
            </h3>
            <span className="projects-group-count">{group.rows.length}</span>
          </div>
          <div className="projects-group-rows" role="list">
            {group.rows.map((project) => {
              const open = openPath === project.path;
              const status = projectStatus({
                project,
                workspacePath,
                openProjectPaths,
              });
              const color = project.color || projectColor(project.path);
              const totalSessions = sessionCounts.get(project.path) ?? 0;
              return (
                <div
                  key={project.path}
                  id={projectRowId(project.path)}
                  role="listitem"
                  className={cx(
                    "projects-row-block",
                    open && "open",
                    status === "active" && "active",
                    status === "archived" && "archived",
                  )}
                >
                  <button
                    type="button"
                    className="projects-row"
                    title={project.path}
                    aria-label={t("project.selectProject", { name: project.name })}
                    aria-expanded={open}
                    aria-current={open ? "true" : undefined}
                    onClick={() => onSelect(project.path)}
                    onDoubleClick={() => onActivate(project.path)}
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
                        {status ? (
                          <span className={cx("projects-tag", status !== "open" && `is-${status}`)}>
                            {t(PROJECT_STATUS_LABEL_KEYS[status])}
                          </span>
                        ) : null}
                      </span>
                      <span className="projects-name-path">
                        {shortenPath(project.path)}
                      </span>
                    </span>
                    <span className="projects-row-meta">
                      <span className="projects-name-sessions">
                        {t("project.sessionsCount", { count: totalSessions })}
                      </span>
                      <span className="projects-updated">
                        {formatUpdated(project.openedAt, locale, t("project.updatedNever"))}
                      </span>
                    </span>
                    <span className="projects-row-disclosure" aria-hidden>
                      <IconChevronRight size={14} />
                    </span>
                  </button>
                  {open && detail ? (
                    <div
                      className="projects-inspector"
                      role="region"
                      aria-label={project.name}
                    >
                      {detail}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
