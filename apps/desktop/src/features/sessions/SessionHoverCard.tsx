import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ProjectWorkspace, SessionCollaborationSummary, SessionReference } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { IconArrowUpRight, IconBranch, IconClock, IconFolder } from "../../components/icons";
import { observeSessionCollaboration } from "./session-collaboration-reader";
import {
  collaborationStatusKey,
  currentCollaborationResult,
  formatSessionTimestamp,
  positionSessionHoverCard,
  sessionPreview,
  sessionReferenceAvailable,
} from "./session-collaboration-view";
import type { SessionHoverCardData } from "./useSessionHoverCard";

export function SessionHoverCard({
  card,
  refreshProject,
  onOpenSession,
  keepVisible,
  scheduleHide,
}: {
  card: SessionHoverCardData;
  refreshProject: (path: string) => Promise<ProjectWorkspace | null>;
  onOpenSession: (sessionId: string) => Promise<void>;
  keepVisible: () => void;
  scheduleHide: () => void;
}) {
  const { t, i18n } = useTranslation();
  const elementRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [summary, setSummary] = useState<SessionCollaborationSummary>();
  const [readState, setReadState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [project, setProject] = useState<{ space: string; branch?: string }>({
    space: card.space,
    branch: card.branch,
  });
  const { session, target } = card;

  useEffect(() => {
    // The card is reusable; its per-session read state must not leak into the
    // next hovered session when the caller does not remount it.
    setSummary(undefined);
    setReadState("loading");
    setProject({ space: card.space, branch: card.branch });
    return observeSessionCollaboration({
      sessionId: session.id,
      read: api.getSessionCollaboration,
      isVisible: () => target.isConnected && !document.hidden && document.hasFocus(),
      onSummary: (next) => {
        setSummary(next);
        setReadState("ready");
      },
      onUnavailable: () => setReadState("unavailable"),
    });
  }, [card.space, card.branch, session.id, target]);

  useEffect(() => {
    if (card.temporary) return;
    let current = true;
    void refreshProject(session.projectPath ?? "").then((workspace) => {
      if (current && target.isConnected && workspace) {
        setProject({ space: workspace.name, branch: workspace.branch });
      }
    }).catch(() => {
      // The cached project label and branch remain useful when this optional read fails.
    });
    return () => { current = false; };
  }, [card.temporary, refreshProject, session.projectPath, target]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const place = () => {
      if (!target.isConnected) return;
      setPosition(positionSessionHoverCard(
        target.getBoundingClientRect(),
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);

  const modeKey = session.mode === "plan" ? "chat.modePlan"
    : session.mode === "goal" ? "chat.modeGoal"
      : session.permissionMode === "auto" ? "chat.permissionAuto"
        : session.permissionMode === "accept-edits" ? "chat.permissionAcceptEdits"
          : session.permissionMode === "ask" ? "chat.permissionAsk" : "chat.modeAgent";
  const result = summary ? currentCollaborationResult(summary) : undefined;
  const modelLabel = summary?.modelName || summary?.providerName;
  const timestamp = (value: string | undefined) => formatSessionTimestamp(value, i18n.language);
  const openSessionReference = (reference: SessionReference) => {
    void onOpenSession(reference.sessionId);
  };

  return createPortal(
    <div
      ref={elementRef}
      id={`session-hover-${session.id}`}
      className="sidebar-session-hover-card"
      role="dialog"
      aria-label={t("sessionCollaboration.sessionDetails", { name: session.title })}
      data-session-collaboration={session.id}
      style={{ ...position, visibility: position ? "visible" : "hidden" }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseEnter={keepVisible}
      onMouseLeave={scheduleHide}
      onFocusCapture={keepVisible}
      onBlurCapture={scheduleHide}
    >
      <div className="sidebar-session-hover-card-title">{session.title}</div>
      <div className="sidebar-session-hover-card-tags">
        {summary?.createdBySession ? (
          <span className="sidebar-session-hover-card-tag">
            <IconBranch size={12} aria-hidden />
            {t("sessionCollaboration.sessionTask")}
          </span>
        ) : null}
        <span className="sidebar-session-hover-card-tag sidebar-session-hover-card-tag-accent">{t(modeKey)}</span>
        <span className="sidebar-session-hover-card-status" data-status={readState === "ready" ? summary?.status : readState}>
          {readState === "ready" && summary
            ? t(collaborationStatusKey(summary.status))
            : readState === "unavailable" ? t("sessionCollaboration.unavailable") : t("sessionCollaboration.loading")}
        </span>
      </div>
      {summary?.createdBySession ? (
        <div className="sidebar-session-hover-card-section">
          <span className="sidebar-session-hover-card-section-label">{t("sessionCollaboration.createdBy")}</span>
          {sessionReferenceAvailable(summary.createdBySession) ? (
            <button
              type="button"
              className="sidebar-session-hover-card-session-link"
              data-session-link={summary.createdBySession.sessionId}
              title={summary.createdBySession.sessionId}
              aria-label={t("sessionCollaboration.openSession", { name: summary.createdBySession.title || summary.createdBySession.sessionId })}
              onClick={() => openSessionReference(summary.createdBySession!)}
            >
              <span className="sidebar-session-hover-card-session-link-title">{summary.createdBySession.title || summary.createdBySession.sessionId}</span>
              <IconArrowUpRight size={12} aria-hidden />
            </button>
          ) : (
            <span
              className="sidebar-session-hover-card-session-link sidebar-session-hover-card-session-link-unavailable"
              data-session-link={summary.createdBySession.sessionId}
              data-session-link-unavailable="true"
              title={t("sessionCollaboration.referenceUnavailable")}
            >
              <span className="sidebar-session-hover-card-session-link-title">{summary.createdBySession.title || summary.createdBySession.sessionId}</span>
              <span className="sr-only">{t("sessionCollaboration.referenceUnavailable")}</span>
            </span>
          )}
        </div>
      ) : null}
      {summary?.createdSessions?.length ? (
        <div className="sidebar-session-hover-card-section">
          <span className="sidebar-session-hover-card-section-label">{t("sessionCollaboration.createdSessions")}</span>
          <ul className="sidebar-session-hover-card-session-links">
            {summary.createdSessions.slice(0, 8).map((reference) => (
              <li key={reference.sessionId}>
                {sessionReferenceAvailable(reference) ? (
                  <button
                    type="button"
                    className="sidebar-session-hover-card-session-link"
                    data-session-link={reference.sessionId}
                    title={reference.sessionId}
                    aria-label={t("sessionCollaboration.openSession", { name: reference.title || reference.sessionId })}
                    onClick={() => openSessionReference(reference)}
                  >
                    <span className="sidebar-session-hover-card-session-link-title">{reference.title || reference.sessionId}</span>
                    <IconArrowUpRight size={12} aria-hidden />
                  </button>
                ) : (
                  <span
                    className="sidebar-session-hover-card-session-link sidebar-session-hover-card-session-link-unavailable"
                    data-session-link={reference.sessionId}
                    data-session-link-unavailable="true"
                    title={t("sessionCollaboration.referenceUnavailable")}
                  >
                    <span className="sidebar-session-hover-card-session-link-title">{reference.title || reference.sessionId}</span>
                    <span className="sr-only">{t("sessionCollaboration.referenceUnavailable")}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary?.currentTask ? (
        <div className="sidebar-session-hover-card-section">
          <span className="sidebar-session-hover-card-section-label">{t("sessionCollaboration.currentTask")}</span>
          <span className="sidebar-session-hover-card-peer">
            {t("sessionCollaboration.receivedFrom", { name: summary.currentTask.senderSession.title || summary.currentTask.senderSession.sessionId })}
          </span>
          <span className="sidebar-session-hover-card-preview">{sessionPreview(summary.currentTask.text)}</span>
        </div>
      ) : null}
      {summary?.recentExchanges.length ? (
        <div className="sidebar-session-hover-card-section">
          <span className="sidebar-session-hover-card-section-label">{t("sessionCollaboration.recentMessages")}</span>
          <ol className="sidebar-session-hover-card-exchanges">
            {summary.recentExchanges.slice(0, 2).map((exchange) => (
              <li key={exchange.messageId}>
                <span className="sidebar-session-hover-card-peer">
                  {t(exchange.direction === "incoming" ? "sessionCollaboration.receivedFrom" : "sessionCollaboration.sentTo", {
                    name: exchange.peer.title || exchange.peer.sessionId,
                  })}
                </span>
                <span className="sidebar-session-hover-card-preview">{sessionPreview(exchange.preview, 180)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {result && (result.error || result.text) ? (
        <div className="sidebar-session-hover-card-section" data-result-status={result.status}>
          <span className="sidebar-session-hover-card-section-label">
            {result.error ? t("sessionCollaboration.failure") : t("sessionCollaboration.result")}
          </span>
          <span className="sidebar-session-hover-card-preview">{sessionPreview(result.error || result.text)}</span>
        </div>
      ) : null}
      <div className="sidebar-session-hover-card-meta">
        {modelLabel ? <div className="sidebar-session-hover-card-model">{modelLabel}</div> : null}
        <div className="sidebar-session-hover-card-meta-row">
          <span className="sidebar-session-hover-card-meta-icon" aria-hidden><IconFolder size={12} /></span>
          <span className="sidebar-session-hover-card-meta-value">
            <span className="sr-only">{t("nav.hoverCardSpace")} </span>
            {project.space}
            {project.branch ? (
              <>
                <span aria-hidden> · </span>
                <span aria-label={t("nav.hoverCardBranchAria", { name: project.branch })}>{project.branch}</span>
              </>
            ) : null}
          </span>
        </div>
        <div className="sidebar-session-hover-card-meta-row">
          <span className="sidebar-session-hover-card-meta-icon" aria-hidden><IconClock size={12} /></span>
          <span className="sidebar-session-hover-card-meta-value">
            {t("nav.hoverCardUpdatedAt", { when: timestamp(session.updatedAt) })}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
