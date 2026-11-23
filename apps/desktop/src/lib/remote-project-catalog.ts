import type {
  RemoteHostSummary,
  RacpProjectSummary,
  SessionSummary,
} from "@pi-desktop/shared";
import type { RemoteProjectTarget } from "./remote-project-session";
import { compareProjectGroups } from "./project-order";
import { isRemoteSession } from "./remote-session-safety";
import type { ProjectSort } from "./sidebar-preferences";

export type RemoteProjectEntry = RemoteProjectTarget & {
  key: string;
  hostLabel: string;
  connected: boolean;
};
export const remoteProjectKey = (hostKey: string, projectId: string) =>
  JSON.stringify([hostKey, projectId]);
/** Collapse-state key for a host project group; the prefix keeps these entries out of the local path namespace. */
export const remoteProjectCollapseKey = (key: string) => `remote::${key}`;

export type RemoteProjectGroup = {
  project: RemoteProjectEntry;
  sessions: SessionSummary[];
};

/**
 * Rendering and range selection consume one grouped order.
 *
 * Groups sort through the same project order the local list uses. Without it a
 * host group's position would follow whichever of its sessions happened to
 * arrive first, so opening a conversation in one host project could move that
 * group above another while the local list stayed put.
 */
export function groupRemoteProjectSessions(
  sessions: SessionSummary[],
  compare: (left: SessionSummary, right: SessionSummary) => number,
  sort: ProjectSort,
): RemoteProjectGroup[] {
  return listRemoteProjects([], [], sessions)
    .map((project) => ({
      project,
      sessions: sessions
        .filter(
          (session) =>
            session.remoteHostKey === project.hostKey &&
            session.remoteProjectId === project.projectId,
        )
        .sort(compare),
    }))
    .sort((left, right) =>
      compareProjectGroups(
        {
          key: left.project.key,
          name: left.project.label,
          sessions: left.sessions,
        },
        {
          key: right.project.key,
          name: right.project.label,
          sessions: right.sessions,
        },
        sort,
      ),
    );
}

export function listRemoteProjects(
  hosts: RemoteHostSummary[],
  inventories: { hostKey: string; projects: RacpProjectSummary[] }[],
  sessions: SessionSummary[],
): RemoteProjectEntry[] {
  const entries = new Map<string, RemoteProjectEntry>();
  for (const session of sessions) {
    if (
      !isRemoteSession(session) ||
      !session.remoteHostKey ||
      !session.remoteProjectId
    )
      continue;
    const host = hosts.find((item) => item.hostKey === session.remoteHostKey);
    const key = remoteProjectKey(
      session.remoteHostKey,
      session.remoteProjectId,
    );
    entries.set(key, {
      key,
      hostKey: session.remoteHostKey,
      projectId: session.remoteProjectId,
      label: session.remoteWorkspaceLabel ?? session.remoteProjectId,
      hostLabel:
        host?.label ?? session.remoteHostLabel ?? session.remoteHostKey,
      connected: host?.connected === true,
    });
  }
  for (const inventory of inventories) {
    const host = hosts.find((item) => item.hostKey === inventory.hostKey);
    if (!host) continue;
    for (const project of inventory.projects) {
      const key = remoteProjectKey(host.hostKey, project.id);
      if (project.archived) {
        entries.delete(key);
        continue;
      }
      entries.set(key, {
        key,
        hostKey: host.hostKey,
        projectId: project.id,
        label: project.label,
        hostLabel: host.label,
        connected: host.connected,
      });
    }
  }
  return [...entries.values()];
}
