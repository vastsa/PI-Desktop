import { randomUUID } from "node:crypto";
import { IPC, isPluginShellLayoutCommand, isPluginShellLayoutResponse, isPluginShellLayoutSnapshot, type PluginShellLayout, type PluginShellLayoutCommand, type PluginShellLayoutMessage, type PluginShellLayoutSnapshot } from "@pi-desktop/shared";

type Pending = {
  pluginId: string;
  bootId: string;
  contextId: string;
  command: PluginShellLayoutCommand;
  resolve: (layout: PluginShellLayout) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  disposeAbort: () => void;
};
type Dependencies = {
  sendToRenderer: (channel: string, message: PluginShellLayoutMessage) => void;
  authorize: (pluginId: string, snapshot: PluginShellLayoutSnapshot) => boolean;
  announce: (snapshot: PluginShellLayoutSnapshot) => void;
  answerTimeoutMs?: number;
  log?: (message: string, error: unknown) => void;
};
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code, errorCode: code }); }

/** Renderer-authoritative request relay. Replies never become committed events. */
export function createPluginShellLayoutRelay({ sendToRenderer, announce, authorize, answerTimeoutMs = 2_000, log }: Dependencies) {
  let current: PluginShellLayoutSnapshot | null = null;
  let committed: PluginShellLayoutSnapshot | null = null;
  const retiredBoots = new Set<string>();
  const pending = new Map<string, Pending>();
  const cancel = (requestId: string, code: string, message: string): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.disposeAbort();
    entry.reject(failure(code, message));
    try { sendToRenderer(IPC.event.pluginShellLayoutRequest, { kind: "cancel", requestId }); }
    catch (error) { log?.("shell layout cancellation delivery failed", error); }
  };
  const accept = (snapshot: PluginShellLayoutSnapshot): boolean => {
    if (retiredBoots.has(snapshot.bootId)) return false;
    if (current?.bootId === snapshot.bootId && snapshot.revision <= current.revision) return false;
    if (current && current.bootId !== snapshot.bootId) retiredBoots.add(current.bootId);
    current = structuredClone(snapshot);
    for (const [requestId, entry] of pending) {
      if (entry.bootId !== snapshot.bootId) cancel(requestId, "UNAVAILABLE", "renderer reloaded");
      else if (entry.command.kind !== "get" && entry.contextId !== snapshot.contextId) cancel(requestId, "UNAVAILABLE", "shell selection changed");
    }
    return true;
  };
  return {
    publish(value: unknown): boolean {
      if (!isPluginShellLayoutSnapshot(value)) throw failure("INVALID_ARGUMENT", "invalid shell layout snapshot");
      if (!accept(value)) return false;
      const changed = !committed || committed.bootId !== value.bootId || committed.contextId !== value.contextId || committed.sessionId !== value.sessionId || committed.projectPath !== value.projectPath || JSON.stringify(committed.layout) !== JSON.stringify(value.layout);
      committed = structuredClone(value);
      if (changed) announce(structuredClone(value));
      return true;
    },
    request(pluginId: string, command: PluginShellLayoutCommand, signal?: AbortSignal): Promise<PluginShellLayout> {
      if (!isPluginShellLayoutCommand(command)) return Promise.reject(failure("INVALID_ARGUMENT", "invalid shell layout command"));
      if (signal?.aborted) return Promise.reject(failure("UNAVAILABLE", "calling plugin page is unavailable"));
      if (!current) return Promise.reject(failure("UNAVAILABLE", "shell renderer is unavailable"));
      if (!authorize(pluginId, current)) return Promise.reject(failure("PERMISSION_DENIED", "plugin is not active in the displayed project"));
      const { bootId, contextId } = current;
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => cancel(requestId, "TIMEOUT", "shell renderer response timed out"), answerTimeoutMs);
        const abort = () => cancel(requestId, "UNAVAILABLE", "calling plugin page is unavailable");
        signal?.addEventListener("abort", abort, { once: true });
        const disposeAbort = () => signal?.removeEventListener("abort", abort);
        pending.set(requestId, { pluginId, bootId, contextId, command, resolve, reject, timer, disposeAbort });
        try { sendToRenderer(IPC.event.pluginShellLayoutRequest, { requestId, bootId, contextId, command, expiresAt: Date.now() + answerTimeoutMs }); }
        catch (error) { pending.delete(requestId); clearTimeout(timer); disposeAbort(); reject(failure("UNAVAILABLE", String(error))); }
      });
    },
    settle(value: unknown): boolean {
      if (!isPluginShellLayoutResponse(value)) throw failure("INVALID_ARGUMENT", "invalid shell layout response");
      const entry = pending.get(value.requestId);
      if (!entry) return false;
      pending.delete(value.requestId);
      clearTimeout(entry.timer);
      entry.disposeAbort();
      if (value.error) { entry.reject(failure(value.error.code, value.error.message)); return true; }
      const snapshot = value.snapshot;
      if (snapshot.bootId !== entry.bootId || snapshot.bootId !== current?.bootId || retiredBoots.has(snapshot.bootId)) {
        entry.reject(failure("UNAVAILABLE", "renderer reloaded"));
      } else if (entry.command.kind !== "get" && (snapshot.contextId !== entry.contextId || current.contextId !== entry.contextId)) {
        entry.reject(failure("UNAVAILABLE", "shell selection changed"));
      } else if (!authorize(entry.pluginId, snapshot)) {
        entry.reject(failure("PERMISSION_DENIED", "plugin is not active in the displayed project"));
      } else if (snapshot.revision < current.revision) {
        entry.reject(failure("UNAVAILABLE", "shell response was overtaken"));
      } else {
        if (snapshot.revision > current.revision) accept(snapshot);
        entry.resolve(structuredClone(snapshot.layout));
      }
      return true;
    },
    clearPlugin(pluginId: string): void {
      for (const [requestId, entry] of pending) if (entry.pluginId === pluginId) cancel(requestId, "UNAVAILABLE", "plugin unloaded");
    },
    rendererLost(): void {
      if (current) retiredBoots.add(current.bootId);
      current = null;
      committed = null;
      for (const requestId of pending.keys()) cancel(requestId, "UNAVAILABLE", "shell renderer is unavailable");
    },
  };
}
export type PluginShellLayoutRelay = ReturnType<typeof createPluginShellLayoutRelay>;
