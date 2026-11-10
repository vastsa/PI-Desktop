import type { AgentSubagentControlRequest, AgentSubagentControlResponse, SubagentDefinition } from "@pi-desktop/shared";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { canControlSubagents } from "./model";
import {
  pruneSubagentControlDrafts, readSubagentControlDraft, subscribeSubagentControlDrafts,
  type SubagentDraftAddress,
} from "./control-drafts";

const usePending = create<{ sessions: Record<string, boolean> }>(() => ({ sessions: {} }));
export function useSubagentControl(sessionId?: string) {
  const session = useAppStore((state) => state.sessions.find((entry) => entry.id === sessionId));
  const allowed = canControlSubagents(session);
  const busy = usePending((state) => sessionId ? state.sessions[sessionId] === true : false);
  const [error, setError] = useState<Error | null>(null);
  const [delivery, setDelivery] = useState<AgentSubagentControlResponse["delivery"] | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const send = async (request: AgentSubagentControlRequest): Promise<AgentSubagentControlResponse | null> => {
    const state = useAppStore.getState();
    if (!sessionId || request.sessionId !== sessionId || state.activeSessionId !== sessionId ||
      !canControlSubagents(state.sessions.find((entry) => entry.id === sessionId)) ||
      usePending.getState().sessions[sessionId]) return null;
    usePending.setState((pending) => ({ sessions: { ...pending.sessions, [sessionId]: true } }));
    setError(null); setDelivery(null);
    try {
      const result = await api.controlSubagent(request);
      if (mounted.current && useAppStore.getState().activeSessionId === sessionId) setDelivery(result.delivery);
      return result;
    } catch (cause) {
      if (mounted.current && useAppStore.getState().activeSessionId === sessionId) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
      return null;
    } finally {
      usePending.setState((pending) => {
        const sessions = { ...pending.sessions };
        delete sessions[sessionId];
        return { sessions };
      });
    }
  };
  return { allowed, busy, error, delivery, send };
}

export function useSubagentControlDraft(address: SubagentDraftAddress) {
  const sessions = useAppStore((state) => state.sessions);
  const ready = useAppStore((state) => state.ready);
  const subscribe = useCallback(subscribeSubagentControlDrafts, []);
  const read = useCallback(() => readSubagentControlDraft(address), [address.sessionId, address.delegationId]);
  useEffect(() => {
    if (ready) pruneSubagentControlDrafts([...sessions.map((session) => session.id), address.sessionId]);
  }, [sessions, address.sessionId, ready]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useSubagentControlCatalog(sessionId: string, allowed: boolean) {
  const [subagents, setSubagents] = useState<SubagentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let disposed = false;
    if (!allowed) { setLoading(false); return; }
    setLoading(true); setError(null); setSubagents([]);
    void api.subagentCatalog().then((catalog) => {
      if (!disposed && useAppStore.getState().activeSessionId === sessionId) setSubagents(catalog.subagents);
    }).catch((cause: unknown) => {
      if (!disposed && useAppStore.getState().activeSessionId === sessionId) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [sessionId, allowed, generation]);
  return { subagents, loading, error, reload: () => setGeneration((value) => value + 1) };
}
