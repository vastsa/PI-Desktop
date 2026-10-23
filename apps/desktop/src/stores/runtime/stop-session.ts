import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { resolveComposerSmartStop } from "../../lib/composer-smart-stop";
import { settleStoppedAssistantMetrics } from "../../lib/context-usage";
import { clearSessionAsks } from "../../lib/pending-asks";
import { clearSessionPermissions, sessionPermissions } from "../../lib/pending-permissions";
import { isRemoteSession, sessionAllows } from "../../lib/remote-session-safety";
import { mergeLiveSessionMessages } from "../../lib/session-transcript";
import type { AppState } from "../app-state";
import type { StoreAccess } from "../slices/types";
import type { SessionRuntime } from "./session-runtime";

type StopDependencies = StoreAccess & {
  runtime: SessionRuntime;
  flushPendingSessionConfiguration: (sessionId: string) => Promise<void>;
};

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function stoppedRows(rows: UiMessage[], stoppedAtMs: number): UiMessage[] {
  let changed = false;
  const completedAt = new Date(stoppedAtMs).toISOString();
  const next = rows.map((message) => {
    if (message.role === "assistant" && message.status === "streaming") {
      changed = true;
      return { ...settleStoppedAssistantMetrics(message, stoppedAtMs), status: "aborted" as const };
    }
    if (message.role === "tool" && message.toolStatus === "running") {
      changed = true;
      return {
        ...message, toolStatus: "error" as const, status: "aborted" as const,
        toolCompletedAt: message.toolCompletedAt ?? completedAt,
      };
    }
    return message;
  });
  return changed ? next : rows;
}

/** Stop owns backend settlement first, then optional draft/history recovery. */
export function createSessionStop({ get, set, runtime, flushPendingSessionConfiguration }: StopDependencies) {
  const pending = new Map<string, { owns: (state: AppState) => boolean; promise: Promise<void> }>();
  return (): Promise<void> => {
    const before = get();
    const sessionId = before.activeSessionId;
    if (!sessionId) return Promise.resolve();
    const target = before.sessions.find((session) => session.id === sessionId);
    if (!sessionAllows(target, "canStop")) return Promise.resolve();
    const active = pending.get(sessionId);
    if (active?.owns(before)) return active.promise;
    const submittedDraft = runtime.submittedComposerDrafts.get(sessionId);
    const rowsForSession = (state: AppState) => state.activeSessionId === sessionId ? state.messages
      : runtime.sessionTranscriptCache.get(sessionId) ?? state.retainedTranscripts[sessionId] ?? before.messages;
    let turnId = before.agentStatuses?.[sessionId]?.currentTurnId;
    let admittedUserId = before.messages.findLast((message) => message.role === "user")?.id;
    let initialAdmissionOpen = Boolean(submittedDraft) && !turnId;
    const owns = (state: AppState) => {
      const nextDraft = runtime.submittedComposerDrafts.get(sessionId);
      if (nextDraft && nextDraft !== submittedDraft) return false;
      if (rowsForSession(state).findLast((message) => message.role === "user")?.id !== admittedUserId) return false;
      const nextTurn = state.agentStatuses?.[sessionId]?.currentTurnId;
      // Stop can precede this submission's first status, but must never adopt
      // a later turn while optional history recovery is still pending.
      if (!turnId && nextTurn && initialAdmissionOpen) turnId = nextTurn;
      return !nextTurn || nextTurn === turnId;
    };
    const stoppedAtMs = Date.now();
    const external = target?.source === "pi-native" || isRemoteSession(target);
    const preserveSteering = before.messages
      .slice(submittedDraft?.messageCountBeforeSend ?? 0)
      .findLast((message) => message.role === "user")?.steering;
    if (submittedDraft && !submittedDraft.abortResolution) {
      submittedDraft.abortResolution = new Promise<boolean>((resolve) => { submittedDraft.resolveAbort = resolve; });
    }
    const finishDraft = (restored: boolean) => {
      submittedDraft?.resolveAbort?.(restored);
      // A newer send owns its own snapshot and must survive this Stop's await.
      if (runtime.submittedComposerDrafts.get(sessionId) === submittedDraft) {
        runtime.submittedComposerDrafts.delete(sessionId);
      }
    };
    const publishRows = (rows: UiMessage[], full = false) => {
      if (!owns(get())) return;
      const window = full ? { messageStart: 0, hasMoreBefore: false } : undefined;
      // The ownership check and publication are synchronous. Update the
      // boundary for rows this Stop itself removes during draft recovery.
      set((current) => ({
        retainedTranscripts: { ...current.retainedTranscripts, [sessionId]: rows },
        ...(window ? { sessionHistory: { ...current.sessionHistory, [sessionId]: window } } : {}),
        ...(current.activeSessionId === sessionId ? { messages: rows } : {}),
      }));
      admittedUserId = rows.findLast((message) => message.role === "user")?.id;
      runtime.cacheSessionTranscript(sessionId, rows, window);
    };
    const settle = () => {
      const current = get();
      if (!owns(current)) return;
      const rows = stoppedRows(rowsForSession(current), stoppedAtMs);
      publishRows(rows);
      set((state) => owns(state) ? {
        runningSessions: { ...state.runningSessions, [sessionId]: false },
        agentStatuses: withoutKey(state.agentStatuses, sessionId),
        pendingPermissions: clearSessionPermissions(state.pendingPermissions, sessionId),
        pendingAsks: clearSessionAsks(state.pendingAsks, sessionId),
        ...(state.activeSessionId === sessionId ? { isRunning: false } : {}),
      } : {});
    };
    const run = async () => {
      // Permission responses may race the terminal event; their failures must
      // not mask the abort RPC or delay publishing an already-settled turn.
      const permissionReplies = external ? Promise.resolve([]) : Promise.allSettled(
        sessionPermissions(before.pendingPermissions, sessionId).map((permission) =>
          api.resolvePermission({ requestId: permission.requestId, decision: "deny" })),
      );
      try {
        await api.abort(sessionId);
        settle();
        initialAdmissionOpen = false;
        if (!owns(get())) return;
        if (external) {
          finishDraft(false);
          const detail = await api.getSession(sessionId);
          if (detail.session?.messages && owns(get())) {
            publishRows(stoppedRows(detail.session.messages, stoppedAtMs));
          }
          return;
        }
        const state = get();
        if (state.activeSessionId !== sessionId) return;
        const smartStop = preserveSteering ? { kind: "settle" as const }
          : resolveComposerSmartStop(state.messages, submittedDraft);
        if (smartStop.kind === "restore") {
          // Never let an old detail request publish into a newer turn's cache.
          const fullMessages = await runtime.loadFullSessionMessages(sessionId, false);
          if (!fullMessages || get().activeSessionId !== sessionId || !owns(get())) return;
          const merged = stoppedRows(mergeLiveSessionMessages(fullMessages, get().messages), stoppedAtMs);
          const fullStop = resolveComposerSmartStop(merged, submittedDraft);
          if (fullStop.kind === "restore") {
            publishRows(fullStop.kept, true);
            set((current) => current.activeSessionId === sessionId && owns(current)
              ? { composerPrefill: { ...fullStop.draft, sessionId } } : {});
            finishDraft(true);
            if (fullStop.kept.length < merged.length) await api.replaceSessionMessages(sessionId, fullStop.kept);
            return;
          }
          publishRows(merged, true);
        }
      } catch (error) {
        set((current) => current.activeSessionId === sessionId && owns(current) ? {
          error: error instanceof Error ? error.message : String(error),
          errorCode: (error as { code?: string })?.code ?? null,
        } : {});
        throw error;
      } finally {
        finishDraft(false);
        // These responses have rejection handlers from the moment they start.
        void permissionReplies;
        if (!external && owns(get()) && !get().runningSessions[sessionId]) {
          void flushPendingSessionConfiguration(sessionId);
        }
      }
    };
    const promise = run();
    const operation = { owns, promise };
    pending.set(sessionId, operation);
    const clear = () => { if (pending.get(sessionId) === operation) pending.delete(sessionId); };
    void promise.then(clear, clear);
    return promise;
  };
}
