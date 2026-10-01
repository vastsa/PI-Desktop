import type { LiveCallView } from "@pi-desktop/shared";
import type { Slot } from "./call-service-internals";

export function toLiveCallView(slot: Slot): LiveCallView {
  return {
    callId: slot.callId,
    revision: slot.revision,
    bindingId: slot.binding?.id ?? "",
    adapterId: slot.binding?.adapterId ?? "codex-live",
    phase: slot.phase,
    muted: slot.muted,
    microphoneActive: slot.microphoneActive,
    userSpeaking: slot.userSpeaking,
    assistantSpeaking: slot.assistantSpeaking,
    ...(slot.workBinding ? { workBinding: slot.workBinding } : {}),
    ...(slot.workOperations.length ? {
      workOperations: slot.workOperations.map((operation) => {
        const feedbackStatus = slot.workFeedbackStatuses.get(operation.operationId);
        return { ...operation, ...(feedbackStatus ? { feedbackStatus } : {}) };
      }),
    } : {}),
    ...(slot.connectedAt ? { connectedAt: slot.connectedAt } : {}),
    ...(slot.playbackBlocked !== undefined ? { playbackBlocked: slot.playbackBlocked } : {}),
    mediaRelease: slot.mediaRelease,
    ...(slot.error ? { error: slot.error } : {}),
    ...(slot.notice ? { notice: slot.notice } : {}),
  };
}
