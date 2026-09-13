import {
  buildTraySessionGroups,
  IPC,
  normalizeProjectPath,
  type AgentEventEnvelope,
  type HostStatusEvent,
  type NotificationListResult,
  type SessionSummary,
  type TraySessionGroup,
  type TraySessionPreferences,
} from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";

const REFRESH_AFTER_INVOKE = new Set<string>([
  IPC.invoke.sessionCreate,
  IPC.invoke.sessionFork,
  IPC.invoke.sessionRename,
  IPC.invoke.sessionDelete,
  IPC.invoke.sessionMoveProject,
  IPC.invoke.sessionSummarizeTitle,
  IPC.invoke.sessionImportRun,
  IPC.invoke.notificationMarkRead,
  IPC.invoke.notificationMarkAllRead,
  IPC.invoke.notificationClear,
]);

/** Main owns native presentation; durable records still come exclusively from Host. */
export function createTraySessions({
  getHost,
  getRunningSessionIds,
  isQuitting,
  onChanged,
  logger,
}: {
  getHost: () => HostProcess | null;
  getRunningSessionIds: () => Iterable<string>;
  isQuitting: () => boolean;
  onChanged: () => void;
  logger: Pick<Logger, "app">;
}) {
  let preferences: TraySessionPreferences = {
    sessionMeta: {},
    archivedProjectPaths: [],
    sort: "recent",
  };
  let sessions: SessionSummary[] = [];
  let groups: TraySessionGroup[] = [];
  let signature = "[]";
  let revision = 0;
  let pending: Promise<void> | null = null;
  let agentAvailable = true;
  let hasPreferences = false;
  // Root terminal events settle the UI before Main releases durable turn ownership.
  const runningOverrides = new Map<string, boolean>();

  function publish(next: TraySessionGroup[]) {
    const nextSignature = JSON.stringify(next);
    if (signature === nextSignature) return;
    signature = nextSignature;
    groups = next;
    onChanged();
  }

  function refresh(): Promise<void> {
    revision += 1;
    if (pending) return pending;
    pending = (async () => {
      let observed: number;
      do {
        observed = revision;
        const host = getHost();
        if (!host || isQuitting()) {
          sessions = [];
          publish([]);
          return;
        }
        try {
          const [listed, inbox] = await Promise.all([
            host.call<{ sessions: SessionSummary[] }>("session.list"),
            host.call<NotificationListResult>("notification.list", { limit: 200 }),
          ]);
          if (isQuitting()) return;
          if (host !== getHost()) {
            revision += 1;
            continue;
          }
          if (observed !== revision) continue;
          sessions = listed.sessions;
          const running = new Set(agentAvailable ? getRunningSessionIds() : []);
          if (agentAvailable) {
            for (const [id, active] of runningOverrides) {
              if (active) running.add(id);
              else running.delete(id);
            }
          }
          const existing = new Set(sessions.map((session) => session.id));
          for (const id of runningOverrides.keys()) {
            if (!existing.has(id)) runningOverrides.delete(id);
          }
          publish(hasPreferences
            ? buildTraySessionGroups(sessions, running, inbox.notifications, preferences)
            : []);
        } catch (error) {
          if (host !== getHost()) {
            revision += 1;
            continue;
          }
          if (observed !== revision || isQuitting()) continue;
          sessions = [];
          publish([]);
          logger.app("diagnostics", "warn", "tray session refresh failed", {
            data: String(error),
          });
        }
      } while (observed !== revision);
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  function observeEvent(channel: string, payload: unknown) {
    if (isQuitting()) return;
    if (channel === IPC.event.agentMessage) {
      const envelope = payload as AgentEventEnvelope;
      if (envelope.parentToolCallId) return;
      const event = envelope.event;
      let running: boolean;
      if (
        event.type === "agent_start" ||
        event.type === "turn_start" ||
        event.type === "compaction_start"
      ) {
        running = true;
      } else if (
        event.type === "agent_end" ||
        event.type === "error" ||
        (event.type === "compaction_end" && event.reason === "manual")
      ) {
        running = false;
      } else if (event.type === "status") {
        running = event.status.isRunning;
      } else {
        return;
      }
      if (runningOverrides.get(envelope.sessionId) === running) return;
      runningOverrides.set(envelope.sessionId, running);
    } else if (channel === IPC.event.hostStatus) {
      const status = payload as HostStatusEvent;
      if (!status.ok) runningOverrides.clear();
      if (!status.component || status.component === "sidecar") agentAvailable = status.ok;
    } else if (channel !== IPC.event.sessionsChanged && channel !== IPC.event.notificationChanged) {
      return;
    }
    void refresh();
  }

  return {
    refresh,
    observeEvent,
    observeInvoke(channel: string) {
      if (REFRESH_AFTER_INVOKE.has(channel)) void refresh();
    },
    getGroups: () => groups,
    setPreferences(next: TraySessionPreferences) {
      hasPreferences = true;
      preferences = next;
      return refresh();
    },
    canActivate(sessionId: string) {
      const session = sessions.find((item) => item.id === sessionId);
      return Boolean(
        session &&
        !preferences.sessionMeta[sessionId]?.archived &&
        !preferences.archivedProjectPaths.includes(normalizeProjectPath(session.projectPath)),
      );
    },
  };
}
