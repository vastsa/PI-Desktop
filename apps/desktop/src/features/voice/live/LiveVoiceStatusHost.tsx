import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { LiveVoiceWidgetAction } from "@pi-desktop/shared";
import { getLiveCallController } from "./live-call-controller";
import { liveVoiceApi } from "./live-voice-api";
import { openLiveVoiceSettings } from "./live-voice-navigation";
import { liveVoiceIssue, liveVoiceMode } from "./live-voice-presentation";
import { LiveVoiceDetails } from "./LiveVoiceDetails";
import "../../../styles/voice.css";

/**
 * The main window's half of the call chrome.
 *
 * The call cannot move to the widget window: this frame owns the microphone,
 * the media, the provider transport and the call-scoped work. So the docked
 * widget draws the compact bar and forwards each press, and this host runs the
 * action with the real controller — including the failures only this frame can
 * observe, which it reports so the widget can name them in place — and keeps the
 * details surface, whose provider, transcript and work targets come from this
 * window's store.
 */
export function LiveVoiceStatusHost() {
  const { t } = useTranslation();
  const controller = getLiveCallController();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [actionFailure, setActionFailure] = useState<{ callId?: string; code: string } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef(snapshot);
  const mode = liveVoiceMode(snapshot);
  const callId = snapshot.call?.callId;
  snapshotRef.current = snapshot;
  // A refused action is local to this frame: the call view never carries it, so
  // it is folded into the issue the widget is told to draw.
  const issue = liveVoiceIssue(actionFailure && actionFailure.callId === callId
    ? { ...snapshot, errorCode: snapshot.errorCode ?? actionFailure.code }
    : snapshot);

  useEffect(() => {
    setDetailsOpen(false);
    setActionFailure(null);
  }, [callId]);

  useEffect(() => {
    if (mode === "stopping" || mode === "idle") setDetailsOpen(false);
  }, [mode]);

  // The widget window is the only call chrome, so the failure this frame owns —
  // a refused mute, a playback retry that failed — has to reach it.
  useEffect(() => {
    if (!callId) return;
    void liveVoiceApi.reportWidgetIssue({ callId, code: issue?.code ?? null }).catch(() => undefined);
  }, [callId, issue?.code]);

  const runAction = useCallback((action: () => Promise<void>, pending?: "mute" | "playback") => {
    setActionFailure(null);
    const startedFor = controller.getSnapshot().call?.callId;
    void action().catch(() => {
      if (controller.getSnapshot().call?.callId === startedFor) {
        setActionFailure({
          callId: startedFor,
          code: pending === "playback" ? "LIVE_PLAYBACK_FAILED" : "LIVE_CALL_ACTION_FAILED",
        });
      }
    });
  }, [controller]);

  // The widget window owns the buttons; every press arrives here as an action.
  useEffect(() => liveVoiceApi.onWidgetAction(({ action }: { action: LiveVoiceWidgetAction }) => {
    const current = snapshotRef.current;
    switch (action) {
      case "cancel":
        runAction(() => (current.starting ? controller.cancelStart() : controller.end()));
        break;
      case "mute":
        runAction(() => controller.toggleMute(), "mute");
        break;
      case "resume":
        // IPC cannot transfer transient user activation from the widget
        // renderer. Main focuses this window for the widget press; the user
        // must click the owner-frame control below so AudioContext/media play
        // runs in a real gesture handler.
        setDetailsOpen(true);
        break;
      case "end":
        runAction(() => controller.end());
        break;
      case "details":
        setDetailsOpen(true);
        break;
      case "settings":
        openLiveVoiceSettings();
        break;
    }
  }), [controller, runAction]);

  return (
    <>
      {/* Details has no trigger in this window any more — the widget's button
          opens it — so it hangs from a fixed point the shell can still show,
          just above the composer. */}
      <div ref={anchorRef} className="live-voice-details-anchor" aria-hidden="true" />
      {snapshot.call ? (
        <LiveVoiceDetails
          key={snapshot.call.callId}
          t={t}
          call={snapshot.call}
          status={snapshot.status}
          transcripts={snapshot.transcripts}
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          onResumePlayback={() => runAction(() => controller.resumePlayback(), "playback")}
          anchorRef={anchorRef}
        />
      ) : null}
    </>
  );
}
