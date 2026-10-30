import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { Button, cx } from "../../components/ui";
import { IconChevronDown, IconClock } from "../../components/icons";
import { ProjectRunBadge, ProjectRunRail } from "../../components/ProjectRunIndicator";
import { loadScheduledSidebarCollapsed, saveScheduledSidebarCollapsed } from "../../lib/sidebar-preferences";
import { resolveSidebarRunningAffordances } from "../../lib/sidebar-project-runs";
import { useAppStore } from "../../stores/app-store";
import { scheduledSidebarRunSummary } from "./sidebar-scheduled-tasks";

export function ScheduledSidebarGroup({ tasks, latestRuns, searching, projectPath, id }: {
  tasks: ScheduledTask[];
  latestRuns: ReadonlyMap<string, ScheduledTaskRun>;
  searching: boolean;
  projectPath: string;
  id: string;
}) {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const pendingPermissions = useAppStore((s) => s.pendingPermissions);
  const openTask = useAppStore((s) => s.openScheduledTask);
  const [collapsed, setCollapsed] = useState(() => loadScheduledSidebarCollapsed(projectPath));
  const isCollapsed = collapsed && !searching;
  const affordances = resolveSidebarRunningAffordances(settings);
  const summary = scheduledSidebarRunSummary(tasks, latestRuns, pendingPermissions);
  const showRail = affordances.rail && summary.running + summary.waiting > 0;

  if (tasks.length === 0) return null;

  return (
    <section
      className={cx("sidebar-session-group sidebar-scheduled-folder", showRail && "has-run-rail", isCollapsed && "is-collapsed")}
      data-sidebar-scheduled-group={projectPath}
      aria-labelledby={`${id}-label`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {showRail && <ProjectRunRail summary={summary} />}
      <div className="sidebar-session-group-header">
        <Button variant="ghost"
          type="button"
          id={`${id}-label`}
          className="sidebar-session-group-title sidebar-scheduled-folder-toggle"
          aria-expanded={!isCollapsed}
          aria-controls={`${id}-tasks`}
          aria-disabled={searching}
          onClick={() => {
            if (searching) return;
            const next = !collapsed;
            setCollapsed(next);
            saveScheduledSidebarCollapsed(projectPath, next);
          }}
        >
          <IconChevronDown size={13} className={cx("sidebar-disclosure-icon", isCollapsed && "collapsed")} aria-hidden />
          <IconClock size={13} aria-hidden />
          <span>{t("scheduled.title")}</span>
          <span className="sidebar-scheduled-folder-count">{tasks.length}</span>
          {affordances.badge && <ProjectRunBadge summary={summary} />}
        </Button>
      </div>
      <div
        id={`${id}-tasks`}
        data-sidebar-scheduled-body="tasks"
        className={cx("sidebar-session-group-body project", isCollapsed && "collapsed")}
        aria-hidden={isCollapsed}
        inert={isCollapsed}
      >
        <div className="sidebar-session-group-clip">
          <div className="sidebar-session-group-list">
            {tasks.map((task) => {
              const rowSummary = scheduledSidebarRunSummary([task], latestRuns, pendingPermissions);
              return (
                <div className="thread-item" key={task.id} data-sidebar-scheduled-task={task.id}>
                  <Button variant="ghost" type="button" className="thread-item-main" onClick={() => openTask(task.id)}>
                    <span className="thread-item-title">{task.title}</span>
                    {!task.enabled && <span className="thread-item-source">{t("scheduled.disabled")}</span>}
                    {affordances.badge && <ProjectRunBadge summary={rowSummary} />}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
