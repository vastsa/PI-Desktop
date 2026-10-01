import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IPC, type AppSettings, type LiveCallView, type LiveVoiceWidgetAction } from "@pi-desktop/shared";
import { LiveVoiceCallBar } from "./LiveVoiceCallBar";
import { liveVoiceApi } from "./live-voice-api";
import { applyAppLanguage } from "../../../lib/app-language";
import { liveVoiceIssue, liveVoiceWidgetSnapshot, liveVoiceWidgetVisible } from "./live-voice-presentation";
import "../../../styles/voice.css";
import "../../../styles/live-voice-widget.css";

type WidgetState = { call: LiveCallView | null; errorCode?: string; decisionWaiting?: boolean };

/**
 * The docked call widget: the call chrome as its own always-on-top window, so a
 * running call stays visible and controllable while the user works in another
 * application.
 *
 * The window is a view, never an owner. Main pushes the authoritative call view
 * in (plus the owner frame's own failure code, which the call view cannot
 * carry); this component decides whether there is anything to show at all,
 * reports the exact box its content needs — a transparent window must not keep
 * dead space that swallows clicks — and forwards every button to main, which
 * runs it in the main window: the frame that owns the microphone, the media and
 * the call-scoped work.
 */
export function LiveVoiceWidget() {
  const { t } = useTranslation();
  const [state, setState] = useState<WidgetState>({ call: null });
  const [dismissedIssue, setDismissedIssue] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLButtonElement>(null);

  const snapshot = useMemo(() => liveVoiceWidgetSnapshot(state.call, state.errorCode), [state]);
  const issue = liveVoiceIssue(snapshot);
  const visible = liveVoiceWidgetVisible(snapshot, dismissedIssue);

  // The widget window is not the app shell: it never boots the shared settings
  // store, so the persisted language is applied here and refreshed whenever a
  // call brings the widget back on screen (the setting may have changed since).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      const result = await window.piDesktop
        ?.invoke<AppSettings>(IPC.invoke.settingsGet)
        .catch(() => null);
      if (cancelled || !result?.ok) return;
      applyAppLanguage(result.data?.language);
    })();
    return () => { cancelled = true; };
  }, [visible]);

  const callId = state.call?.callId;

  // Subscribe in a layout effect before reporting the presentation below. The
  // main process replays its latest state in response to that report, closing
  // the did-finish-load/passive-effect race for the first call snapshot.
  useLayoutEffect(() => liveVoiceApi.onWidgetState((next) => setState(next)), []);

  // Every call starts with a clean presentation: a failure the user dismissed
  // during the last call must not stay silent during the next one.
  useEffect(() => {
    setDismissedIssue(null);
  }, [callId]);
  // The window follows the content: main shows exactly the box drawn here, and
  // the bar grows when a failure line or a wider action row appears.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const report = () => {
      const rect = shell.getBoundingClientRect();
      // A status row that must not fold can still be wider than the window the
      // bar is currently drawn in: the scroll box is the width it needs, so the
      // window grows to the content instead of clipping the controls away.
      void liveVoiceApi.setWidgetPresentation({
        visible,
        width: Math.ceil(Math.max(rect.width, shell.scrollWidth)),
        height: Math.ceil(Math.max(rect.height, shell.scrollHeight)),
      }).catch(() => undefined);
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [issue?.key, state, visible]);

  const request = useCallback((action: LiveVoiceWidgetAction) => {
    void liveVoiceApi.requestWidgetAction(action).catch(() => undefined);
  }, []);

  return (
    <div className="live-voice-widget" ref={shellRef}>
      {/* Nothing to show means nothing drawn: a hidden widget must not keep the
          bar's box alive for main to show or to swallow desktop clicks. */}
      {visible ? (
        <LiveVoiceCallBar
          t={t}
          snapshot={snapshot}
          issue={issue}
          decisionWaiting={state.decisionWaiting === true}
          detailsOpen={false}
          detailsRef={detailsRef}
          actionPending={null}
          onCancel={() => request("cancel")}
          onMute={() => request("mute")}
          onEnd={() => request("end")}
          onDetails={() => request("details")}
          onResume={() => request("resume")}
          onSettings={() => request("settings")}
          onDismiss={() => setDismissedIssue(issue?.key ?? null)}
        />
      ) : null}
    </div>
  );
}
