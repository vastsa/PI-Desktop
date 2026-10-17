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
import { IconFolder, IconNewProject } from "../icons";
import { Button, TooltipButton } from "../ui";

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
    return <section
      className={`sidebar-session-group project-group ${runIsLive ? "has-running-sessions" : ""} ${showRunRail ? "has-run-rail" : ""}`}
      key={project.key}
    >
      {showRunRail ? <ProjectRunRail summary={runSummary} /> : null}
      <div className="sidebar-session-group-header">
        <Button variant="ghost" className="sidebar-session-group-title" disabled={busy !== null}
          title={`${project.hostLabel} · ${project.label}`} onClick={() => void open(project)}>
          <IconFolder size={13} aria-hidden /><span>{project.label} · {project.hostLabel}</span>
          {showRunBadge ? <ProjectRunBadge summary={runSummary} /> : null}
          {showRunRail ? <ProjectRunCount summary={runSummary} /> : null}
        </Button>
        <TooltipButton tooltip={t("nav.newTask")} ariaLabel={`${t("nav.newTask")}: ${project.label} · ${project.hostLabel}`}
          disabled={busy !== null} onClick={() => void open(project)}><IconNewProject size={14} /></TooltipButton>
      </div>
      {renderSessions(sessions)}
    </section>;
  })}</>;
}
