/**
 * The GitHub connector's state for a renderer surface (ADR github-connector).
 *
 * Main owns the credential and pushes a status whenever it changes — a login
 * finishing, a pasted token, disconnect, or GitHub rejecting the stored token
 * in some other part of the app. A surface reads the status once and then
 * follows those pushes, so Settings and the composer never disagree about who
 * is connected. The status holds an account and its scopes, never the token.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubConnectorStatus } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

export type GitHubConnectorState = {
  /** Null until the first read answers. */
  status: GitHubConnectorStatus | null;
  loading: boolean;
  /** Why the last read failed, or null. */
  error: string | null;
  refresh(): Promise<void>;
};

export function useGitHubConnector(): GitHubConnectorState {
  const [status, setStatus] = useState<GitHubConnectorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A pushed status and a newer read both outrank a read still in flight.
  const latest = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const next = await api.githubConnectorStatus();
      if (!mounted.current || request !== latest.current) return;
      setStatus(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current || request !== latest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && request === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const stop = api.onGithubConnectorChanged((next) => {
      latest.current += 1;
      setStatus(next);
      setError(null);
      setLoading(false);
    });
    void refresh();
    return () => {
      mounted.current = false;
      latest.current += 1;
      stop();
    };
  }, [refresh]);

  return { status, loading, error, refresh };
}
