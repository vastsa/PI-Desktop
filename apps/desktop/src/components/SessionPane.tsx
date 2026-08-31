import { memo } from "react";
import { ChatTranscript } from "./ChatTranscript";
import { useAppStore } from "../stores/app-store";
import { headPermission, sessionPermissions } from "../lib/pending-permissions";
import { headAsk } from "../lib/pending-asks";

/**
 * One retained conversation pane (ADR 0135).
 *
 * The chat surface mounts one of these per retained session and keys it on the
 * session id, so a pane's transcript DOM, scroll offset, and mounted-row window
 * belong to that session for the pane's whole lifetime. Switching sessions then
 * reveals an already-painted pane instead of re-pointing one shared transcript
 * at different data, which is what made the chat area flash.
 *
 * A pane reads the live `messages` projection while it owns the store-active
 * session, and its retained snapshot once another session takes over. That way
 * leaving a session never blanks the pane the user can come back to.
 */
export const SessionPane = memo(function SessionPane({
  sessionId,
  visible,
}: {
  sessionId: string;
  visible: boolean;
}) {
  const isActiveProjection = useAppStore(
    (state) => state.activeSessionId === sessionId,
  );
  const liveMessages = useAppStore((state) => state.messages);
  const snapshot = useAppStore((state) => state.retainedTranscripts[sessionId]);
  const messages = isActiveProjection ? liveMessages : snapshot ?? [];
  const hasMoreBefore = useAppStore(
    (state) => state.sessionHistory[sessionId]?.hasMoreBefore === true,
  );
  const loadOlderMessages = useAppStore((state) => state.loadOlderMessages);
  const isRunning = useAppStore(
    (state) => state.runningSessions[sessionId] ?? false,
  );
  const pendingPermission = useAppStore((state) =>
    headPermission(state.pendingPermissions, sessionId),
  );
  const queuedPermissions = useAppStore((state) =>
    Math.max(0, sessionPermissions(state.pendingPermissions, sessionId).length - 1),
  );
  const askPending = useAppStore((state) =>
    Boolean(headAsk(state.pendingAsks, sessionId)),
  );
  const planningState = useAppStore((state) => state.planningStates[sessionId]);

  return (
    <div
      className="session-pane"
      data-session-pane={sessionId}
      data-visible={visible ? "true" : "false"}
      // Hidden panes keep their layout box (and therefore their scroll offset);
      // they are removed from the accessibility tree and from hit testing so
      // only the visible conversation can be read or operated.
      aria-hidden={visible ? undefined : true}
      inert={visible ? undefined : true}
    >
      <ChatTranscript
        sessionId={sessionId}
        messages={messages}
        hasMoreBefore={hasMoreBefore}
        onLoadOlder={() => loadOlderMessages(sessionId)}
        isRunning={isRunning}
        pendingPermission={pendingPermission}
        queuedPermissions={queuedPermissions}
        askPending={askPending}
        planningState={planningState}
        paneVisible={visible}
      />
    </div>
  );
});
