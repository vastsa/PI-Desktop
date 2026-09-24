import { sessionSurfaceGates, type SessionSurfaceGates } from "../lib/session-capabilities";
import { useAppStore } from "../stores/app-store";

/**
 * One surface gate of the active session. Selects a primitive so a transcript
 * row re-renders only when the gate itself flips, not on every session update.
 */
export function useActiveSessionGate(gate: keyof SessionSurfaceGates): boolean {
  return useAppStore((state) => {
    const active = state.sessions.find((session) => session.id === state.activeSessionId);
    return sessionSurfaceGates(active)[gate];
  });
}
