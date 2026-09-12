export type TaskNotificationVisibility = {
  finishingSessionId: string;
  viewingSessionId: string | null;
  windowVisible: boolean;
  windowFocused: boolean;
};

/**
 * Durable task notifications are only suppressed for the exact chat result
 * currently visible in a focused window. Every unknown or background state
 * fails safe to notification.
 */
export function shouldCreateTaskNotification({
  finishingSessionId,
  viewingSessionId,
  windowVisible,
  windowFocused,
}: TaskNotificationVisibility): boolean {
  const resultIsVisible =
    windowVisible &&
    windowFocused &&
    viewingSessionId !== null &&
    viewingSessionId === finishingSessionId;
  return !resultIsVisible;
}

export type NativeNotificationKind = "task" | "interactive";

export type NativeNotificationVisibility = {
  kind: NativeNotificationKind;
  sessionId: string;
  viewingSessionId: string | null;
  windowVisible: boolean;
  windowFocused: boolean;
};

/**
 * Task outcomes are only native when the app is unfocused. Interactive asks
 * retain their focused-background behavior, but stay silent for the exact
 * visible session that can answer them immediately.
 */
export function shouldShowNativeNotification({
  kind,
  sessionId,
  viewingSessionId,
  windowVisible,
  windowFocused,
}: NativeNotificationVisibility): boolean {
  if (!windowVisible || !windowFocused) return true;
  if (kind === "task") return false;
  return viewingSessionId !== sessionId;
}
