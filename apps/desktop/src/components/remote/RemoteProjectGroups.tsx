import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import type { RemoteProjectEntry, RemoteProjectGroup } from "../../lib/remote-project-catalog";
import {
  projectRunSummaryIsLive,
  resolveSidebarRunningAffordances,
  summarizeProjectRuns,
} from "../../lib/sidebar-project-runs";
import { useAppStore } from "../../stores/app-store";
import { ProjectRunBadge, ProjectRunCount, ProjectRunRail } from "../ProjectRunIndicator";
import { IconChevronDown, IconFolder, IconNewSession } from "../icons";
import { TooltipButton } from "../ui";

/** A stable DOM id from the catalog key, which is a JSON tuple rather than a path. */
function groupDomId(key: string): string {
  return `remote-project-${key.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/** The same project/chat hierarchy, keyed by Host identity rather than local paths. */
export function RemoteProjectGroups({ groups, renderSessions }: {
  groups: RemoteProjectGroup[]; renderSessions: (sessions: SessionSummary[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const settings = useAppStore((state) => state.settings);
  // Remote groups carry the same running affordances as local projects, so a
  // collapsed host group does not hide live work either.
  const runAffordances = resolveSidebarRunningAffordances(settings);
  const runningSessions = useAppStore((state) => state.runningSessions);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  // Collapse is the shared project-group state, so a host project folds
  // exactly like a local one and survives a restart with the rest of the
  // sidebar. The catalog key never reaches `openProjectPaths`, so it cannot
  // resurrect a group after the project disappears.
  const collapsedGroups = useAppStore((state) => state.projectCollapsed);
  const setProjectCollapsed = useAppStore((state) => state.setProjectCollapsed);
  const open = async (project: RemoteProjectEntry) => {
    if (busy) return;
    setBusy(project.key);
    try { await useAppStore.getState().newSession({ remoteProject: project }); }
    catch (error) { useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" }); }
    finally { setBusy(null); }
  };
  return <>{groups.map(({ project, sessions }) => {
    const runSummary = summarizeProjectRuns(sessions, runningSessions, pendingPermissions);
    const runIsLive = projectRunSummaryIsLive(runSummary);
    const showRunBadge = runAffordances.badge && runIsLive;
    const showRunRail = runAffordances.rail && runIsLive;
    // Same exclusivity rule as the local sidebar: one set of numbers, owned by
    // the badge while it is on and by the rail when it is off.
    const showRunCount = runAffordances.railCount && runIsLive;
    const collapsed = collapsedGroups[project.key] ?? false;
    const domId = groupDomId(project.key);
    return <section
      className={`sidebar-session-group project-group ${runIsLive ? "has-running-sessions" : ""} ${showRunRail ? "has-run-rail" : ""} ${collapsed ? "is-collapsed" : ""}`}
      key={project.key}
      aria-labelledby={domId}
    >
      {showRunRail ? <ProjectRunRail summary={runSummary} /> : null}
      <div className="sidebar-session-group-header">
        <TooltipButton type="button" id={domId} className="sidebar-session-group-title project-toggle"
          tooltip={`${project.hostLabel} · ${project.label}`}
          ariaLabel={`${project.label} · ${project.hostLabel}`}
          aria-expanded={!collapsed}
          aria-controls={`${domId}-sessions`}
          data-action="toggle-project-collapse"
          onClick={() => setProjectCollapsed(project.key, !collapsed)}>
          <IconChevronDown size={13} className={`sidebar-disclosure-icon ${collapsed ? "collapsed" : ""}`} />
          <IconFolder size={13} aria-hidden /><span>{project.label} · {project.hostLabel}</span>
          {showRunBadge ? <ProjectRunBadge summary={runSummary} /> : null}
          {showRunCount ? <ProjectRunCount summary={runSummary} /> : null}
        </TooltipButton>
        {/* The add action is the sidebar's own control, not a generic button:
            the generic `.btn` padding and centering would pull the header off the
            local group rail this row is meant to match. */}
        <TooltipButton type="button" className="sidebar-session-group-add"
          tooltip={t("nav.newTask")} ariaLabel={`${t("nav.newTask")}: ${project.label} · ${project.hostLabel}`}
          disabled={busy !== null} onClick={() => void open(project)}><IconNewSession size={13} /></TooltipButton>
      </div>
      <div id={`${domId}-sessions`}
        className={`sidebar-session-group-body project ${collapsed ? "collapsed" : ""}`}
        role="region" aria-hidden={collapsed} inert={collapsed ? true : undefined}>
        <div className="sidebar-session-group-clip">
          <div className="sidebar-session-group-list">{renderSessions(sessions)}</div>
        </div>
      </div>
    </section>;
  })}</>;
}
