import { type RefObject } from "react";
import type { TFunction } from "i18next";
import { IconClose, IconInfo, IconMic, IconMicOff, IconPhoneOff, IconSettings, IconVolume, IconWaveform } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import type { LiveVoiceSnapshot } from "./live-call-controller";
import { liveVoiceMode, type liveVoiceIssue } from "./live-voice-presentation";

type CallBarProps = {
  t: TFunction;
  snapshot: LiveVoiceSnapshot;
  issue: ReturnType<typeof liveVoiceIssue>;
  /**
   * True while the bound work session waits on a decision the user has to make
   * elsewhere. The widget window has no session store, so the owner frame
   * reports this instead of the bar deriving it (live-work-decision).
   */
  decisionWaiting: boolean;
  detailsOpen: boolean;
  detailsRef: RefObject<HTMLButtonElement | null>;
  actionPending: "mute" | "playback" | null;
  onCancel: () => void;
  onMute: () => void;
  onEnd: () => void;
  onDetails: () => void;
  onResume: () => void;
  onSettings: () => void;
  onDismiss: () => void;
};

/**
 * The compact call bar, drawn by the docked widget window from the state main
 * pushes. It is presentation only — the widget owns no media and is not the
 * call owner, so every button forwards an action instead of reaching a
 * controller — and it is the only call chrome the user sees. A failure that
 * outlives a toast is therefore drawn in place next to its verbatim `LIVE_*`
 * code, because nothing else on screen could name it.
 */
export function LiveVoiceCallBar({
  t, snapshot, issue, decisionWaiting, detailsOpen, detailsRef, actionPending,
  onCancel, onMute, onEnd, onDetails, onResume, onSettings, onDismiss,
}: CallBarProps) {
  const mode = liveVoiceMode(snapshot);
  const call = snapshot.call;
  const status = mode === "stopping" ? "liveVoice.phase.closing"
    : mode === "connecting" ? "liveVoice.phase.connecting"
      : mode === "reconnecting" ? "liveVoice.phase.reconnecting"
        : mode === "idle" ? "liveVoice.phase.failed"
          : call?.muted ? "liveVoice.muted"
            : call?.userSpeaking ? "liveVoice.userSpeaking"
              : call?.assistantSpeaking ? "liveVoice.assistantSpeaking"
                : "liveVoice.phase.connected";
  const unmute = call?.muted !== false;
  const speaking = mode === "connected" && (call?.assistantSpeaking || (call?.userSpeaking && !call.muted));
  return (
    <div className="live-voice-call-bar" data-state={mode}>
      <div className="live-voice-call-row">
        <div className="live-voice-call-status" role="status" aria-live="polite" aria-atomic="true">
          {mode === "connecting" || mode === "reconnecting" || mode === "stopping"
            ? <span className="voice-spinner" aria-hidden="true" />
            : <IconWaveform size={17} className={speaking ? "voice-mic-active" : undefined} aria-hidden="true" />}
          <span><strong>{t("liveVoice.title")}</strong><span className="live-voice-status-text"> · {t(status)}</span></span>
        </div>
        <div className="live-voice-call-actions">
          {mode === "connecting" ? (
            <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("common.cancel")} onClick={onCancel}>
              <IconClose size={17} aria-hidden="true" />
            </TooltipButton>
          ) : null}
          {mode === "connected" || mode === "reconnecting" ? (
            <>
              {call?.playbackBlocked ? (
                <TooltipButton type="button" className="icon-btn icon-btn-square live-voice-resume" tooltip={t("liveVoice.resumePlayback")} disabled={actionPending === "playback"} onClick={onResume}>
                  <IconVolume size={17} aria-hidden="true" />
                </TooltipButton>
              ) : null}
              {mode === "connected" ? (
                <TooltipButton
                  type="button"
                  className={`icon-btn icon-btn-square${unmute ? " live-voice-muted" : ""}`}
                  tooltip={t(unmute ? "liveVoice.unmute" : "liveVoice.mute")}
                  aria-pressed={call?.muted ?? true}
                  disabled={actionPending === "mute"}
                  onClick={onMute}
                >
                  {unmute ? <IconMicOff size={17} aria-hidden="true" /> : <IconMic size={17} aria-hidden="true" />}
                </TooltipButton>
              ) : null}
              <TooltipButton type="button" className="icon-btn icon-btn-square live-voice-end" tooltip={t("liveVoice.end")} onClick={onEnd}>
                <IconPhoneOff size={17} aria-hidden="true" />
              </TooltipButton>
            </>
          ) : null}
          {(mode === "connected" || mode === "reconnecting" || mode === "idle") && call ? (
            <TooltipButton ref={detailsRef} type="button" className="icon-btn icon-btn-square" tooltip={t("liveVoice.details")} aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={onDetails}>
              <IconInfo size={17} aria-hidden="true" />
            </TooltipButton>
          ) : null}
          {mode === "idle" ? (
            <>
              <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("errors.action.openSettings")} onClick={onSettings}>
                <IconSettings size={16} aria-hidden="true" />
              </TooltipButton>
              {issue?.code !== "LIVE_MEDIA_RELEASE_UNCONFIRMED" ? (
                <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("errors.action.dismiss")} onClick={onDismiss}>
                  <IconClose size={16} aria-hidden="true" />
                </TooltipButton>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {issue ? (
        <p className={issue.warning ? "live-voice-feedback live-voice-hint" : "live-voice-feedback live-voice-error"} role={issue.warning ? "status" : "alert"}>
          {t(issue.message)}
          {/* The localized sentence alone cannot say whether authentication,
              entitlement or the transport failed; the allow-listed code can,
              and it is what a log line or bug report needs. Raw provider text
              never reaches this bar (live-voice spec). */}
          <code className="live-voice-error-code">{issue.code}</code>
        </p>
      ) : null}
      {decisionWaiting && (mode === "connected" || mode === "reconnecting") ? (
        <p className="live-voice-feedback live-voice-hint" role="status">{t("liveVoice.decisionWaiting")}</p>
      ) : null}
    </div>
  );
}
