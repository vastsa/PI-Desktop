import type { PluginProjectInfo } from "@pi-desktop/plugin-sdk";
import type { ProjectGroupRecord, ProjectRecord } from "@pi-desktop/shared";
import type { GroupHost } from "../workspace-roots";

/** Read durable projects without activating a workspace or granting file access. */
export function createPluginProjectLister(
  getHost: () => GroupHost | null,
  reportFailure: (operation: string) => void,
): () => Promise<PluginProjectInfo[]> {
  return async () => {
    const host = getHost();
    if (!host?.isAvailable()) return [];
    try {
      const result = await host.call("projects.list", undefined, 5_000) as { projects?: ProjectRecord[] } | null;
      if (!Array.isArray(result?.projects)) {
        reportFailure("projects.list");
        return [];
      }
      let groups: ProjectGroupRecord[] = [];
      try {
        const listed = await host.call("project.groups.list", undefined, 5_000) as { groups?: ProjectGroupRecord[] } | null;
        if (Array.isArray(listed?.groups)) groups = listed.groups;
        else reportFailure("project.groups.list");
      } catch {
        // Group metadata is optional; every durable row still has its own root.
        reportFailure("project.groups.list");
      }
      if (getHost() !== host || !host.isAvailable()) return [];
      return [...result.projects]
        .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt || left.id - right.id)
        .map((project) => {
          const group = groups.find((candidate) => candidate.primaryPath === project.path);
          const primaryName = group?.roots.find((root) => root.path === project.path)?.name ?? project.name;
          const roots = [...(group?.roots ?? [])]
            .sort((left, right) => left.position - right.position)
            .filter((root) => root.path !== project.path)
            .map((root) => ({ path: root.path, name: root.name, primary: false }));
          return {
            projectId: String(project.id),
            name: group?.name ?? project.name,
            primaryPath: project.path,
            roots: [{ path: project.path, name: primaryName, primary: true }, ...roots],
          };
        });
    } catch {
      reportFailure("projects.list");
      return [];
    }
  };
}
