import { getLiveCallController, type LiveCallController } from "./live-call-controller";

type LiveVoiceShortcutController = Pick<
  LiveCallController,
  "getSnapshot" | "start" | "end" | "cancelStart"
>;

const TERMINAL_PHASES = new Set(["ended", "failed", "idle"]);

/** Run the existing configurable Live Voice shortcut actions. */
export function runLiveVoiceShortcut(
  shortcutId: "voiceToggle" | "voiceCancel",
  controller: LiveVoiceShortcutController = getLiveCallController(),
): boolean {
  const snapshot = controller.getSnapshot();

  if (shortcutId === "voiceCancel") {
    if (!snapshot.starting) return false;
    void controller.cancelStart().catch(() => undefined);
    return true;
  }

  if (snapshot.starting) return false;
  if (snapshot.call && !TERMINAL_PHASES.has(snapshot.call.phase)) {
    void controller.end().catch(() => undefined);
    return true;
  }
  if (
    snapshot.status?.enabled !== true ||
    !snapshot.status.bindings.some((binding) => binding.selectable)
  ) {
    return false;
  }

  void controller.start().catch(() => undefined);
  return true;
}
