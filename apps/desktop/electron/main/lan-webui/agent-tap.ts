import type { AgentEventEnvelope } from "@pi-desktop/shared";

type Listener = (envelope: AgentEventEnvelope) => void;
const listeners = new Set<Listener>();

/** Fan out one renderer-bound agent event to the LAN WebUI, never throwing. */
export function publishLanAgentEvent(envelope: AgentEventEnvelope): void {
  for (const listener of listeners) {
    try {
      listener(envelope);
    } catch {
      // A browser-side observer must never disturb the desktop event stream.
    }
  }
}

export function onLanAgentEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
