import { useSyncExternalStore } from "react";

const messages = new Map<string, string>();
const listeners = new Set<() => void>();
export function setRendererDiagnostic(pluginId: string, error?: unknown): void {
  if (error === undefined) messages.delete(pluginId);
  else messages.set(pluginId, error instanceof Error ? error.message : String(error));
  for (const listener of listeners) listener();
}
export function useRendererDiagnostic(pluginId: string): string | undefined {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => messages.get(pluginId));
}
