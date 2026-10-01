import { useMemo, useState, type RefObject } from "react";
import type { TFunction } from "i18next";
import type { LiveCallView, LiveStatus, LiveTranscriptSegment } from "@pi-desktop/shared";
import { IconClose, IconExternal } from "../../../components/icons";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { Button, Panel, TooltipButton } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import { liveVoiceApi } from "./live-voice-api";
import { formatWorkSessionLabel } from "./live-voice-presentation";
import { liveWorkDecision, operationAwaitsDecision } from "./live-work-decision";
import { LiveWorkDecisionNotice } from "./LiveWorkDecisionNotice";
import { LiveWorkOperations } from "./LiveWorkOperations";

export function LiveVoiceDetails({ t, call, status, transcripts, open, onClose, onResumePlayback, anchorRef }: {
  t: TFunction;
  call: LiveCallView;
  status: LiveStatus | null;
  transcripts: LiveTranscriptSegment[];
  open: boolean;
  onClose: () => void;
  onResumePlayback: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const selectSession = useAppStore((state) => state.selectSession);
  const createSession = useAppStore((state) => state.newSession);
  const planCheckpoints = useAppStore((state) => state.planCheckpoints);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  const pendingAsks = useAppStore((state) => state.pendingAsks);
  const [message, setMessage] = useState<string | null>(null);
  const [busyOperationId, setBusyOperationId] = useState<string | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const provider = status?.bindings.find((binding) => binding.bindingId === call.bindingId);
  const viewingSession = sessions.find((session) => session.id === activeSessionId);
  const workBinding = call.workBinding;
  const boundSessionId = workBinding?.workSessionId;
  // The work session can wait on the user while the call is connected and the
  // user is looking at another session entirely. Live Voice cannot answer for
  // them, so the panel has to name the pending request and open that session.
  const decision = useMemo(
    () => liveWorkDecision({
      sessionId: boundSessionId,
      awaiting: operationAwaitsDecision(call.workOperations, boundSessionId),
      asks: pendingAsks,
      permissions: pendingPermissions,
      planCheckpoints,
    }),
    [boundSessionId, call.workOperations, pendingAsks, pendingPermissions, planCheckpoints],
  );

  const openDecision = (sessionId: string) => {
    setMessage(null);
    setDecisionPending(true);
    void selectSession(sessionId).then(
      // The card lives in that session's Composer dock: close the popup so the
      // decision is visible and focusable instead of covered by this panel.
      () => onClose(),
      () => setMessage(t("liveVoice.sessionOpenFailed")),
    ).finally(() => setDecisionPending(false));
  };

  const openSelection = async (callId: string, selectionRef: string) => {
    const target = await liveVoiceApi.resolveWorkSelection({ callId, selectionRef });
    if (target.kind !== "session") throw new Error("The selected item is not a session");
    await selectSession(target.sessionId);
  };

  const createSessionForProject = async (callId: string, selectionRef: string) => {
    const target = await liveVoiceApi.resolveWorkSelection({ callId, selectionRef });
    if (target.kind !== "project") throw new Error("The selected item is not a project");
    await createSession({ projectPath: target.projectPath });
  };

  return (
    <AnchoredMenu
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      trigger={() => null}
      role="dialog"
      label={t("liveVoice.details")}
      side="top"
      align="end"
      menuClassName="live-voice-popup live-voice-details-popup"
    >
      <Panel className="live-voice-details">
        <div className="live-voice-panel-heading">
          <strong>{t("liveVoice.details")}</strong>
          {call.playbackBlocked ? (
            <Button size="sm" variant="secondary" onClick={onResumePlayback}>
              {t("liveVoice.resumePlayback")}
            </Button>
          ) : null}
          <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("common.close")} onClick={onClose}>
            <IconClose size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        <div className="live-voice-service-label">
          <span className="live-voice-hint">{t("liveVoice.provider")}</span>
          <strong>{provider?.providerLabel ?? t("liveVoice.providerUnavailable")}</strong>
          <span className="live-voice-hint">{t(`liveVoice.adapters.${call.adapterId}.title`)}</span>
        </div>
        <section className="live-voice-work-setup" aria-label={t("liveVoice.workStatusTitle")}>
          {workBinding ? (
            <>
              <div className="live-voice-service-row">
                <span>{t("liveVoice.boundWorkSession", { label: workBinding.label || t("liveVoice.untitledWorkSession") })}</span>
                {workBinding.sessionSource ? <span className="live-voice-hint">{t(`liveVoice.sessionSource.${workBinding.sessionSource}`)}</span> : null}
                <TooltipButton
                  type="button"
                  className="icon-btn icon-btn-square"
                  tooltip={t("liveVoice.viewWorkSession")}
                  onClick={() => void selectSession(workBinding.workSessionId).catch(() => setMessage(t("liveVoice.sessionOpenFailed")))}
                >
                  <IconExternal size={15} aria-hidden="true" />
                </TooltipButton>
              </div>
              <p className="live-voice-hint">{t(workBinding.contextEnabled ? "liveVoice.contextShared" : "liveVoice.contextNotShared")}</p>
              {activeSessionId !== workBinding.workSessionId ? (
                <p className="live-voice-hint">{t("liveVoice.viewingDifferentSession", {
                  label: viewingSession
                    ? formatWorkSessionLabel(viewingSession.projectPath, viewingSession.title, t("liveVoice.untitledWorkSession"))
                    : t("liveVoice.unknownSession"),
                })}</p>
              ) : null}
              {decision ? (
                <LiveWorkDecisionNotice
                  decision={decision}
                  t={t}
                  busy={decisionPending}
                  onOpen={() => openDecision(decision.sessionId)}
                />
              ) : null}
            </>
          ) : <p className="live-voice-hint" role="status">{t("liveVoice.noWorkTarget")}</p>}
          <LiveWorkOperations
            callId={call.callId}
            currentSessionId={workBinding?.workSessionId}
            operations={call.workOperations ?? []}
            t={t}
            busyOperationId={busyOperationId}
            setBusyOperationId={setBusyOperationId}
            setMessage={setMessage}
            onOpenSelection={openSelection}
            onCreateSession={createSessionForProject}
          />
        </section>
        {message ? <p className="live-voice-hint" role="status">{message}</p> : null}
        <section aria-label={t("liveVoice.transcript")} className="live-voice-transcript-section">
          <span className="live-voice-hint">{t("liveVoice.transcript")}</span>
          {transcripts.length ? (
            <div className="live-voice-transcripts selectable" aria-live="polite" aria-relevant="additions text">
              {transcripts.map((segment) => (
                <p key={`${segment.role}:${segment.id}`} data-role={segment.role}>{segment.text}</p>
              ))}
            </div>
          ) : <p className="live-voice-hint">{t("liveVoice.transcriptEmpty")}</p>}
        </section>
      </Panel>
    </AnchoredMenu>
  );
}
