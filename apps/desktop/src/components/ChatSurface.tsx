import { memo, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChatTranscript } from "./ChatTranscript";
import { Composer } from "./Composer";
import { HomeMascotLogo } from "./HomeMascotLogo";
import { IconX } from "./icons";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { useAppStore } from "../stores/app-store";
import { headPermission, sessionPermissions } from "../lib/pending-permissions";
import { headAsk } from "../lib/pending-asks";

const StableComposer = memo(Composer);

function i18nHasError(t: (key: string) => string, code: string) {
  const key = `errors.${code}`;
  return t(key) !== key;
}

function projectName(path?: string | null, name?: string | null) {
  if (name) return name;
  if (!path) return null;
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * Top-level chat page surface.
 *
 * Manages the session-switching transition: while a new session is loading,
 * the last settled transcript stays mounted as a dimmed, non-interactive frame
 * until the deferred destination is ready. Keeping the transcript boundary
 * alive avoids a skeleton-to-transcript remount, which otherwise makes the
 * chat area flash and discards the transcript's scroll/hydration continuity.
 *
 * Also reads all store state needed by the inner ChatTranscript and Composer,
 * isolating them from direct store subscriptions that would cause extraneous
 * re-renders.
 */
export const ChatSurface = memo(function ChatSurface() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const selectingSessionId = useAppStore((state) => state.selectingSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const messages = useAppStore((state) => state.messages);
  const sessionHistory = useAppStore((state) => state.sessionHistory);
  const loadOlderMessages = useAppStore((state) => state.loadOlderMessages);
  const isRunning = useAppStore((state) => state.isRunning);
  const workspace = useAppStore((state) => state.workspace);
  const openProject = useAppStore((state) => state.openProject);
  const error = useAppStore((state) => state.error);
  const errorCode = useAppStore((state) => state.errorCode);
  const errorRetriable = useAppStore((state) => state.errorRetriable);
  const activeSession = useAppStore((state) =>
    state.activeSessionId
      ? state.sessions.find((session) => session.id === state.activeSessionId)
      : undefined,
  );

  // Permission queue for the active session.
  const activePermission = useAppStore((state) =>
    state.activeSessionId
      ? headPermission(state.pendingPermissions, state.activeSessionId)
      : undefined,
  );
  const queuedPermissions = useAppStore((state) => {
    if (!state.activeSessionId) return 0;
    const queue = sessionPermissions(
      state.pendingPermissions,
      state.activeSessionId,
    );
    return Math.max(0, queue.length - 1);
  });

  // Ask queue for the active session.
  const askPending = useAppStore((state) =>
    Boolean(
      state.activeSessionId &&
        headAsk(state.pendingAsks, state.activeSessionId),
    ),
  );

  // Planning state for the active session.
  const planningState = useAppStore((state) =>
    state.activeSessionId
      ? state.planningStates[state.activeSessionId]
      : undefined,
  );

  const heroProject = useMemo(
    () =>
      activeSession?.projectPath?.trim()
        ? projectName(activeSession.projectPath, workspace?.name)
        : null,
    [activeSession?.projectPath, workspace?.name],
  );
  const isTemporarySession = Boolean(
    activeSessionId && activeSession && !activeSession.projectPath?.trim(),
  );
  const emptyTitleParts = useMemo(() => {
    const marker = "__PROJECT__";
    const template = t("chat.emptyTitleInProject", { project: marker });
    const [before = "", after = ""] = template.split(marker);
    return { before, after };
  }, [t]);

  const currentTranscriptView = useMemo(
    () => ({
      sessionId: activeSessionId,
      messages,
      isRunning,
      pendingPermission: activePermission,
      queuedPermissions,
      askPending,
      planningState,
    }),
    [
      activePermission,
      activeSessionId,
      askPending,
      isRunning,
      messages,
      planningState,
      queuedPermissions,
    ],
  );

  // React may render the active session identity before it has prepared the
  // destination transcript. Keep the last settled view as the visible frame
  // until that deferred identity catches up; this prevents old messages from
  // being paired with a new session id for one paint.
  const deferredSessionId = useDeferredValue(activeSessionId);
  const previousTranscriptViewRef = useRef(currentTranscriptView);
  const transcriptView =
    deferredSessionId === activeSessionId
      ? currentTranscriptView
      : previousTranscriptViewRef.current;
  const sessionSwitching =
    Boolean(selectingSessionId) ||
    transcriptView.sessionId !== activeSessionId;

  useEffect(() => {
    if (deferredSessionId === activeSessionId) {
      previousTranscriptViewRef.current = currentTranscriptView;
    }
  }, [activeSessionId, currentTranscriptView, deferredSessionId]);

  const hasTranscript =
    Boolean(transcriptView.pendingPermission) ||
    transcriptView.askPending ||
    transcriptView.messages.some((message) => {
      const hasContent = Boolean((message.content || "").trim());
      const hasThinking =
        typeof message.thinking === "string" &&
        Boolean(message.thinking.trim());
      if (message.role === "assistant") return hasContent || hasThinking;
      return hasContent || message.role === "tool";
    });
  return (
    <div
      className={`chat-surface route-surface${sessionSwitching ? " session-switching" : ""}`}
      aria-busy={sessionSwitching}
    >
      {sessionSwitching ? (
        <div className="session-switch-progress" aria-hidden>
          <span />
        </div>
      ) : null}
      {!hasTranscript ? (
        <div
          className="home-main-content"
          data-testid="home-empty"
          data-home-session-kind={
            heroProject ? "project" : isTemporarySession ? "temporary" : "empty"
          }
        >
          <div className="home-scroll">
            <div className="home-stack-inner">
              <div className="empty-hero">
                <div
                  className="empty-hero-icon"
                  data-testid="home-icon"
                  aria-hidden
                >
                  <HomeMascotLogo />
                </div>
                <h1>
                  {heroProject ? (
                    <>
                      {emptyTitleParts.before}
                      <button
                        type="button"
                        className="project-underline"
                        onClick={() => void openProject()}
                        title={
                          workspace?.path ||
                          activeSession?.projectPath ||
                          t("project.open")
                        }
                      >
                        {heroProject}
                      </button>
                      {emptyTitleParts.after}
                    </>
                  ) : isTemporarySession ? (
                    t("chat.emptyTitleTemporary")
                  ) : (
                    t("chat.emptyTitle")
                  )}
                </h1>
                <p className="empty-hero-subtitle">
                  {t(
                    isTemporarySession
                      ? "chat.emptySubtitleTemporary"
                      : "chat.emptySubtitle",
                  )}
                </p>
              </div>
              <OnboardingChecklist />
            </div>
          </div>
          <div className="home-composer-wrap">
            <StableComposer variant="home" />
          </div>
        </div>
      ) : (
        <>
          <ChatTranscript
            sessionId={transcriptView.sessionId}
            messages={transcriptView.messages}
            hasMoreBefore={Boolean(
              transcriptView.sessionId &&
                sessionHistory[transcriptView.sessionId]?.hasMoreBefore,
            )}
            onLoadOlder={() =>
              transcriptView.sessionId
                ? loadOlderMessages(transcriptView.sessionId)
                : Promise.resolve()
            }
            isRunning={transcriptView.isRunning}
            pendingPermission={transcriptView.pendingPermission}
            queuedPermissions={transcriptView.queuedPermissions}
            askPending={transcriptView.askPending}
            planningState={transcriptView.planningState}
          />
          <StableComposer variant="docked" />
        </>
      )}

      {error ? (
        <div className="chat-error-layer">
          <div className="chat-error-notice">
            <span title={error ?? undefined}>
              {errorCode && i18nHasError(t, errorCode)
                ? t(`errors.${errorCode}`)
                : error}
            </span>
            {(errorCode === "MODEL_NOT_CONFIGURED" ||
              errorCode === "PROVIDER_SECRET_MISSING" ||
              errorCode === "PROVIDER_UNAUTHORIZED") && (
              <button
                type="button"
                className="chat-error-action"
                onClick={() => {
                  const store = useAppStore.getState();
                  store.setSettingsTab("agent");
                  store.setPage("settings");
                }}
              >
                {t("errors.action.openSettings")}
              </button>
            )}
            {errorRetriable && !isRunning ? (
              <button
                type="button"
                className="chat-error-action"
                onClick={() =>
                  void useAppStore.getState().retryLastPrompt()
                }
              >
                {t("errors.action.retry")}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t("errors.action.dismiss")}
              className="chat-error-dismiss"
              onClick={() => useAppStore.getState().clearError()}
            >
              <IconX size={13} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});
