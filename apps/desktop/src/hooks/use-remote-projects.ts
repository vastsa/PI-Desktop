import { useEffect, useMemo, useState } from "react";
import type { RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { listRemoteProjects } from "../lib/remote-project-catalog";
import { useAppStore } from "../stores/app-store";

/** Keep existing remote histories reachable without importing Host project catalogs. */
export function useRemoteProjects(enabled: boolean) {
  const sessions = useAppStore((state) => state.sessions);
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setBusy(true); setError(null);
    void (async () => {
      try {
        const result = await api.listRemoteHosts();
        if (!live) return;
        setHosts(result.hosts);
      } catch (caught) {
        if (live) setError(caught instanceof Error ? caught.message : String(caught));
      } finally { if (live) setBusy(false); }
    })();
    return () => { live = false; };
  }, [enabled]);
  const projects = useMemo(() => listRemoteProjects(hosts, [], sessions), [hosts, sessions]);
  return { projects, busy, error };
}
