import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api } from "../lib/api";

export type HostCollection<T> = {
  data: T;
  setData: Dispatch<SetStateAction<T>>;
  /** First paint only: the page shows skeletons until the first load lands. */
  loading: boolean;
  /** Later reloads keep the rows on screen and only dim them. */
  refreshing: boolean;
  reload: () => Promise<void>;
};

/**
 * Loads a host-backed collection and reloads it whenever a plugin changes or
 * the host comes back (the agent capability pages: skills, MCP servers,
 * subagents).
 *
 * Skeletons belong to the first paint only; later reloads dim the list instead
 * of tearing it down, so toggling a row never blinks the page away. Every
 * request is stamped with a counter and only the newest one may write state,
 * so a slow fetch for the previous project can never land after the current
 * one and overwrite it.
 */
export function useHostCollection<T>(
  fetcher: () => Promise<T>,
  empty: T,
  onError: (error: unknown) => void,
): HostCollection<T> {
  const [data, setData] = useState<T>(empty);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hydrated = useRef(false);
  const latestRequest = useRef(0);
  const emptyRef = useRef(empty);
  emptyRef.current = empty;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reload = useCallback(async () => {
    const requestId = ++latestRequest.current;
    const isCurrent = () => requestId === latestRequest.current;
    if (hydrated.current) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await fetcher();
      if (!isCurrent()) return;
      setData(next);
      hydrated.current = true;
    } catch (error) {
      if (!isCurrent()) return;
      onErrorRef.current(error);
      setData(emptyRef.current);
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [fetcher]);

  useEffect(() => {
    void reload();
    const offPluginChanged = api.onPluginChanged(() => void reload());
    const offHostStatus = api.onHostStatus((status) => {
      if (status.ok) void reload();
    });
    return () => {
      offPluginChanged();
      offHostStatus();
      // Retire any request still in flight so it cannot write after unmount
      // or after the fetcher (e.g. the selected project) has changed.
      latestRequest.current += 1;
    };
  }, [reload]);

  return { data, setData, loading, refreshing, reload };
}
