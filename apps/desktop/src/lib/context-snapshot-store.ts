import type { TrustedExtensionStatusEvent } from "@pi-desktop/shared";
import {
  CONTEXT_SNAPSHOT_STATUS_KEY,
  parseContextSnapshotStatus,
  type ContextPanelSnapshot,
} from "./context-panel.ts";

const MAX_SNAPSHOTS = 32;
const snapshots = new Map<string, ContextPanelSnapshot>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeContextSnapshots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getContextSnapshot(sessionId: string | undefined): ContextPanelSnapshot | null {
  return sessionId ? snapshots.get(sessionId) ?? null : null;
}

export function clearContextSnapshot(sessionId: string): void {
  if (snapshots.delete(sessionId)) notify();
}

export function recordContextSnapshot(event: TrustedExtensionStatusEvent): boolean {
  if (event.key !== CONTEXT_SNAPSHOT_STATUS_KEY || !event.sessionId.trim()) return false;
  if (event.text === undefined) {
    clearContextSnapshot(event.sessionId);
    return true;
  }
  const next = parseContextSnapshotStatus(event.text);
  if (!next) return false;
  const current = snapshots.get(event.sessionId);
  if (current && next.at < current.at) return false;
  snapshots.delete(event.sessionId);
  snapshots.set(event.sessionId, next);
  if (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest) snapshots.delete(oldest);
  }
  notify();
  return true;
}
