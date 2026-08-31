import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Composer } from "./Composer";
import { HomeMascotLogo } from "./HomeMascotLogo";
import { IconX } from "./icons";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { SessionPane } from "./SessionPane";
import { useAppStore } from "../stores/app-store";
import { headPermission } from "../lib/pending-permissions";
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
 * Holds the retained session panes (ADR 0136). Every session the user has
 * visited recently keeps its own mounted `SessionPane`, bounded by
 * `RETAINED_SESSION_PANE_LIMIT`; switching reveals the destination pane and
 * hides the others, so no transcript is rebuilt and no frame is dimmed. Only a
 * session with no retained pane has to wait, and that wait is marked by the
 * progress track alone while the current pane stays on screen.
 *
 * The composer is mounted once for the surface rather than per branch: it owns
 * per-session drafts already, and remounting it on every switch discarded its
 * measured metrics and focus.
 */
export const ChatSurface = memo(function ChatSurface() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const selectingSessionId = useAppStore((state) => state.selectingSessionId);
  const retainedSessionIds = useAppStore((state) => state.retainedSessionIds);
  const messages = useAppStore((state) => state.messages);
  // Only the error layer's retry affordance needs the run state here; each pane
  // reads its own session's flag.
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

  // A pending permission or ask is itself transcript content, so the empty
  // state must yield to it. Each pane subscribes to its own queues; the surface
  // only needs the visible session's to choose between empty state and panes.
  const activePermission = useAppStore((state) =>
    state.activeSessionId
      ? headPermission(state.pendingPermissions, state.activeSessionId)
      : undefined,
  );
  const askPending = useAppStore((state) =>
    Boolean(
      state.activeSessionId &&
        headAsk(state.pendingAsks, state.activeSessionId),
    ),
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

  // The head of the retained order is the session on screen. It equals
  // `activeSessionId` except during a cold switch, where the destination has no
  // pane yet: the surface then keeps showing the pane it already has instead of
  // blanking or dimming it, and the store promotes the destination once its
  // transcript commits.
  const visibleSessionId = retainedSessionIds[0];
  // Only a cold switch is a wait worth marking. Once the destination is the
  // visible pane the user is already reading it, so a warm switch (including
  // re-selecting the session already on screen) shows no progress track even
  // though revalidation may still be in flight.
  const sessionSwitching =
    Boolean(selectingSessionId) && selectingSessionId !== visibleSessionId;

  const hasTranscript =
    Boolean(activePermission) ||
    askPending ||
    messages.some((message) => {
      const hasContent = Boolean((message.content || "").trim());
      const hasThinking =
        typeof message.thinking === "string" &&
        Boolean(message.thinking.trim());
      if (message.role === "assistant") return hasContent || hasThinking;
      return hasContent || message.role === "tool";
    });
  // The empty state belongs to the session on screen. While a cold switch is
  // still resolving, the visible pane keeps its own transcript, so the hero must
  // not take over just because the destination projection is still empty.
  const showEmptyState =
    !hasTranscript && (!visibleSessionId || visibleSessionId === activeSessionId);
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
      {showEmptyState ? (
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
          <div className="session-panes">
            {retainedSessionIds.map((id) => (
              <SessionPane
                key={id}
                sessionId={id}
                visible={id === visibleSessionId}
              />
            ))}
          </div>
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
