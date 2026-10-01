import type { LiveCallView, LiveStatus } from "@pi-desktop/shared";
import type { LiveVoiceSnapshot } from "./live-call-controller";
import { liveVoiceErrorKey } from "./live-voice-error";

export type LiveVoiceMode = "idle" | "connecting" | "reconnecting" | "connected" | "stopping";

export function liveVoiceMode(snapshot: LiveVoiceSnapshot): LiveVoiceMode {
  if (snapshot.stopping || snapshot.call?.phase === "closing") return "stopping";
  if (snapshot.starting) return "connecting";
  switch (snapshot.call?.phase) {
    case "connected": return "connected";
    case "reconnecting": return "reconnecting";
    case "preparing":
    case "acquiring-mic":
    case "negotiating":
    case "connecting": return "connecting";
    default: return "idle";
  }
}

export function hasUnconfirmedMediaRelease(snapshot: LiveVoiceSnapshot): boolean {
  return snapshot.call?.error?.code === "LIVE_MEDIA_RELEASE_UNCONFIRMED" || snapshot.errorCode === "LIVE_MEDIA_RELEASE_UNCONFIRMED";
}

export function selectedLiveBinding(status: LiveStatus | null) {
  return status?.bindings.find((binding) => binding.bindingId === status.selectedBindingId);
}

export function liveReadinessMessage(status: LiveStatus | null): string | null {
  if (!status?.enabled) return "liveVoice.enableInSettings";
  const binding = selectedLiveBinding(status);
  if (!binding) return "liveVoice.noProvider";
  if (!binding.selectable) return `liveVoice.readiness.${binding.reason ?? "invalid-settings"}`;
  return null;
}

const ERROR_MESSAGES: Record<string, string> = {
  LIVE_MICROPHONE_DENIED: "liveVoice.microphoneDenied",
  LIVE_MICROPHONE_BUSY: "liveVoice.microphoneBusy",
  LIVE_MICROPHONE_UNAVAILABLE: "liveVoice.microphoneUnavailable",
  LIVE_MEDIA_RELEASE_UNCONFIRMED: "liveVoice.mediaReleaseUnconfirmed",
  LIVE_PLAYBACK_BLOCKED: "liveVoice.playbackBlocked",
  LIVE_PLAYBACK_FAILED: "liveVoice.playbackFailed",
  LIVE_NOT_CONFIGURED: "liveVoice.noProvider",
  LIVE_DISABLED: "liveVoice.enableInSettings",
  LIVE_EXECUTION_NOT_CONNECTED: "liveVoice.workNotConnected",
  LIVE_CALL_ACTION_FAILED: "liveVoice.callActionFailed",
};

export function liveVoiceIssue(snapshot: LiveVoiceSnapshot) {
  const { call } = snapshot;
  const terminal = call?.phase === "ended" || call?.phase === "failed" || call?.phase === "idle";
  const notice = terminal || (call?.notice?.code === "LIVE_PLAYBACK_BLOCKED" && !call.playbackBlocked)
    ? undefined
    : call?.notice?.code;
  const code = call?.error?.code === "LIVE_MEDIA_RELEASE_UNCONFIRMED" || snapshot.errorCode === "LIVE_MEDIA_RELEASE_UNCONFIRMED"
    ? "LIVE_MEDIA_RELEASE_UNCONFIRMED"
    : call?.error?.code ?? snapshot.errorCode ?? notice
    ?? (!terminal && call?.playbackBlocked ? "LIVE_PLAYBACK_BLOCKED" : undefined);
  if (!code) return null;
  // The bar must name the actual cause: the call-specific table wins,
  // `liveVoiceErrorKey` covers the account/transport codes, and only genuinely
  // unmapped codes fall back — a network failure no longer reads as a generic
  // "check your service configuration" problem. Only this key and the verbatim
  // code reach the bar; a raw provider or credential message never does.
  const mapped = ERROR_MESSAGES[code] ?? liveVoiceErrorKey(code);
  const message = mapped !== "liveVoice.errorGeneric"
    ? mapped
    : code.startsWith("LIVE_WORK_") ? "liveVoice.workActionFailed"
    : call?.phase === "connected" ? "liveVoice.callActionFailed"
    : "liveVoice.errorGeneric";
  return {
    code,
    key: `${call?.callId ?? "start"}:${code}`,
    message,
    warning: code === "LIVE_PLAYBACK_BLOCKED",
  };
}

export function formatWorkSessionLabel(projectPath: string | undefined, title: string, untitledLabel: string) {
  const projectLabel = projectPath?.split(/[\\/]/).filter(Boolean).at(-1);
  const sessionLabel = title.trim() || untitledLabel;
  return projectLabel ? `${projectLabel} / ${sessionLabel}` : sessionLabel;
}

/**
 * The docked widget window renders the view main pushes; it never runs the call
 * (media, microphone lease and work scope stay in the owner frame), so the
 * owner's local lifecycle flags cannot cross to it. Both are recoverable from
 * the view: a closing phase is stopping, and so is a terminal phase whose
 * renderer release is still pending — the bar keeps saying "Ending" until the
 * release is confirmed rather than dropping the controls early.
 */
export function liveVoiceWidgetSnapshot(view: LiveCallView | null, ownerErrorCode?: string): LiveVoiceSnapshot {
  const stopping = view?.phase === "closing" ||
    ((view?.phase === "ended" || view?.phase === "failed") && view?.mediaRelease === "pending");
  // The owner frame's own failure wins: a refused action is local to the frame
  // that ran it and never reaches the call view. The quarantine is a
  // `mediaRelease` value in the view and a code everywhere else, so it is
  // translated here — the widget must keep that one failure on screen until the
  // app restarts, and it can only do that by code.
  const errorCode = view?.mediaRelease === "unconfirmed"
    ? "LIVE_MEDIA_RELEASE_UNCONFIRMED"
    : ownerErrorCode ?? view?.error?.code;
  return {
    status: null,
    call: view,
    transcripts: [],
    starting: false,
    stopping,
    ...(errorCode ? { errorCode } : {}),
  };
}

/** Whether the docked widget has anything to show at all. */
export function liveVoiceWidgetVisible(snapshot: LiveVoiceSnapshot, dismissedIssue: string | null): boolean {
  if (liveVoiceMode(snapshot) !== "idle") return true;
  const issue = liveVoiceIssue(snapshot);
  if (!issue) return false;
  // An unconfirmed media release cannot be dismissed into a reusable call slot,
  // so it stays on screen until the app restarts.
  return hasUnconfirmedMediaRelease(snapshot) || issue.key !== dismissedIssue;
}
