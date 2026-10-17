import type { RemoteHostSummary, RacpProjectSummary, SessionSummary } from "@pi-desktop/shared";
import type { RemoteProjectTarget } from "./remote-project-session";
import { isRemoteSession } from "./remote-session-safety";

export type RemoteProjectEntry = RemoteProjectTarget & { key: string; hostLabel: string; connected: boolean };
export const remoteProjectKey = (hostKey: string, projectId: string) => JSON.stringify([hostKey, projectId]);

export type RemoteProjectGroup = { project: RemoteProjectEntry; sessions: SessionSummary[] };

/** Rendering and range selection consume one grouped order. */
export function groupRemoteProjectSessions(
  sessions: SessionSummary[], compare: (left: SessionSummary, right: SessionSummary) => number,
): RemoteProjectGroup[] {
  return listRemoteProjects([], [], sessions).map((project) => ({
    project, sessions: sessions.filter((session) => session.remoteHostKey === project.hostKey
      && session.remoteProjectId === project.projectId).sort(compare),
  }));
}

export function listRemoteProjects(
  hosts: RemoteHostSummary[],
  inventories: { hostKey: string; projects: RacpProjectSummary[] }[],
  sessions: SessionSummary[],
): RemoteProjectEntry[] {
  const entries = new Map<string, RemoteProjectEntry>();
  for (const session of sessions) {
    if (!isRemoteSession(session) || !session.remoteHostKey || !session.remoteProjectId) continue;
    const host = hosts.find((item) => item.hostKey === session.remoteHostKey);
    const key = remoteProjectKey(session.remoteHostKey, session.remoteProjectId);
    entries.set(key, { key, hostKey: session.remoteHostKey, projectId: session.remoteProjectId,
      label: session.remoteWorkspaceLabel ?? session.remoteProjectId,
      hostLabel: host?.label ?? session.remoteHostLabel ?? session.remoteHostKey,
      connected: host?.connected === true });
  }
  for (const inventory of inventories) {
    const host = hosts.find((item) => item.hostKey === inventory.hostKey);
    if (!host) continue;
    for (const project of inventory.projects) {
      const key = remoteProjectKey(host.hostKey, project.id);
      if (project.archived) { entries.delete(key); continue; }
      entries.set(key, { key, hostKey: host.hostKey, projectId: project.id,
        label: project.label, hostLabel: host.label, connected: host.connected });
    }
  }
  return [...entries.values()];
}
