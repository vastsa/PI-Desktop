import {
  isPluginShellLayoutRequest,
  type PluginShellLayoutCommand,
  type PluginShellLayoutMessage,
  type PluginShellLayoutRequest,
  type PluginShellLayoutResponse,
  type PluginShellLayoutSnapshot,
} from "@pi-desktop/shared";
import type { readPluginShellLayout } from "./plugin-shell-layout-model";

type LiveLayout = ReturnType<typeof readPluginShellLayout>;
type Dependencies = {
  bootId: string;
  read: () => LiveLayout;
  apply: (command: PluginShellLayoutCommand, contextId: string) => boolean;
  publish: (snapshot: PluginShellLayoutSnapshot) => Promise<unknown>;
  respond: (response: PluginShellLayoutResponse) => Promise<unknown>;
  reportError: (error: unknown) => void;
  now?: () => number;
};

/** Owns only IPC work; the shell/store remain the sole owners of layout. */
export function createPluginShellLayoutController(dependencies: Dependencies) {
  const { bootId, read, apply, publish, respond, reportError, now = Date.now } = dependencies;
  let revision = 0;
  let lastPublished = "";
  let disposed = false;
  let draining = false;
  const queued = new Map<string, PluginShellLayoutRequest>();
  let active: { request: PluginShellLayoutRequest; awaitingCommit: boolean } | null = null;

  const snapshot = (current: LiveLayout): PluginShellLayoutSnapshot => ({
    bootId, revision: ++revision, contextId: current.contextId, sessionId: current.sessionId, projectPath: current.projectPath, layout: current.layout,
  });
  const send = (response: PluginShellLayoutResponse) => {
    void respond(response).catch(reportError);
  };
  const fail = (request: PluginShellLayoutRequest, error: unknown) => {
    const value = error as { code?: string; message?: string };
    send({ requestId: request.requestId, error: { code: value?.code ?? "UNAVAILABLE", message: value?.message ?? String(error) } });
  };
  const check = (request: PluginShellLayoutRequest, current: LiveLayout) => {
    if (request.bootId !== bootId) throw new Error("Shell renderer changed before applying the request");
    if (request.expiresAt <= now()) throw new Error("Shell layout request expired");
    if (request.command.kind !== "get" && request.contextId !== current.contextId) throw new Error("Shell context changed before applying the request");
  };
  const announce = (current: LiveLayout) => {
    if (!current.settled) return;
    const key = JSON.stringify([current.contextId, current.sessionId, current.projectPath, current.layout]);
    if (key === lastPublished) return;
    lastPublished = key;
    void publish(snapshot(current)).catch(reportError);
  };
  const drain = () => {
    if (disposed || draining) return;
    draining = true;
    try {
      let current: LiveLayout;
      try { current = read(); } catch (error) {
        if ((error as { code?: string }).code !== "UNAVAILABLE") reportError(error);
        return;
      }
      if (active) {
        try {
          check(active.request, current);
          if (active.awaitingCommit || !current.settled) return;
          announce(current);
          send({ requestId: active.request.requestId, snapshot: snapshot(current) });
        } catch (error) { fail(active.request, error); }
        active = null;
      }
      announce(current);
      for (const [requestId, request] of queued) {
        try { check(request, current); } catch (error) {
          queued.delete(requestId);
          fail(request, error);
          continue;
        }
        if (!current.settled) return;
        queued.delete(requestId);
        active = { request, awaitingCommit: true };
        try {
          const changed = apply(request.command, request.contextId);
          if (changed) return;
          current = read();
          send({ requestId, snapshot: snapshot(current) });
        } catch (error) { fail(request, error); }
        active = null;
      }
    } finally { draining = false; }
  };
  return {
    receive(message: PluginShellLayoutMessage) {
      if (disposed) return;
      if ("kind" in message && message.kind === "cancel") {
        queued.delete(message.requestId);
        if (active?.request.requestId === message.requestId) active = null;
        drain();
        return;
      }
      if (!isPluginShellLayoutRequest(message)) {
        reportError(new Error("Invalid shell layout request"));
        return;
      }
      if (message.command.kind === "get") {
        try {
          const current = read();
          check(message, current);
          send({ requestId: message.requestId, snapshot: snapshot(current) });
        } catch (error) { fail(message, error); }
        return;
      }
      queued.set(message.requestId, message);
      drain();
    },
    /** A parent React commit is required before acknowledging a changed command. */
    committed() {
      if (active) active.awaitingCommit = false;
      drain();
    },
    /** A child geometry update can finish presentation, but cannot stand in for a parent commit. */
    notify: drain,
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error("Shell renderer was disposed");
      if (active) fail(active.request, error);
      for (const request of queued.values()) fail(request, error);
      queued.clear();
      active = null;
    },
  };
}
