import { useEffect, useState } from "react";
import type { RepositoryProject } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

export function useRepositoryProjects(hasRemoteProjects: boolean) {
  const [projects, setProjects] = useState<Record<string, RepositoryProject>>({});
  const [hostLabels, setHostLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!hasRemoteProjects) return;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void Promise.all([api.listProjectGroups(), api.listRemoteHosts()]).then(([{ groups }, { hosts }]) => {
        if (current !== generation) return;
        setProjects(Object.fromEntries(groups.flatMap((group) => group.repository ? [[group.primaryPath, group.repository]] : [])));
        setHostLabels(Object.fromEntries(hosts.map((host) => [host.hostKey, host.label])));
      }).catch(() => undefined);
    };
    const off = api.onSessionsChanged((event) => {
      if (event.reason === "remote.host.changed" || event.reason === "remote.repository.project") refresh();
    });
    refresh();
    return () => { ++generation; off(); };
  }, [hasRemoteProjects]);
  return { projects, hostLabels };
}
