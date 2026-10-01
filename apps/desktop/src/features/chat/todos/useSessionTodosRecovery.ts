import { useEffect } from "react";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { startSessionTodosRecovery } from "./session-todos-recovery";

export function useSessionTodosRecovery(sessionId: string): void {
  useEffect(() => startSessionTodosRecovery(sessionId, {
    getTodos: api.getTodos,
    onHostStatus: api.onHostStatus,
    applySnapshot: (snapshot) => useAppStore.getState().applyTodosChanged(snapshot),
    reportError: (error) => console.error("Session checklist recovery failed", error),
  }), [sessionId]);
}
