import { useEffect, useState } from "react";
import type { RemoteEnvironment, RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

export function useEnvironments() {
  const [environments, setEnvironments] = useState<RemoteEnvironment[]>([]);
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void Promise.all([api.listEnvironments(), api.listRemoteHosts()]).then(([env, paired]) => {
        if (current !== generation) return;
        setEnvironments(env.environments);
        setHosts(paired.hosts);
        setError(undefined);
        setLoaded(true);
      }, (cause) => {
        if (current === generation) setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    const offEnv = api.onEnvironmentsChanged(refresh);
    const offHost = api.onSessionsChanged((event) => {
      if (event.reason === "remote.host.changed") refresh();
    });
    refresh();
    return () => { ++generation; offEnv(); offHost(); };
  }, []);
  return { environments, hosts, loaded, error };
}
