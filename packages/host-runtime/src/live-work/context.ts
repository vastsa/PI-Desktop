import type { LiveWorkSelectionOption, UiMessage } from "@pi-desktop/shared";

import type { LiveWorkCandidate, LiveWorkPendingQuestion, WorkSnapshot } from "./coordinator.js";
import type { LiveWorkAdmission, LiveWorkExecution } from "./operation-ledger.js";

const MAX_CLASSIFIER_CONTEXT_BYTES = 12 * 1024;
const MAX_RECENT_TRANSCRIPT_BYTES = 6 * 1024;

export type LiveWorkContextMessage = Pick<UiMessage, "role" | "content"> &
  Partial<Pick<UiMessage, "voiceOrigin" | "toolName" | "parentToolCallId" | "attachments">>;

/** Build the bounded, plain-text input for the existing one-shot classifier. */
export function buildLiveWorkClassifierInput(input: {
  candidate: Pick<LiveWorkCandidate, "instruction">;
  snapshot: WorkSnapshot;
  contextEnabled: boolean;
  recentMessages?: LiveWorkContextMessage[];
  pendingQuestion?: LiveWorkPendingQuestion;
  recentOperations?: Array<{
    operationId: string;
    admission: LiveWorkAdmission;
    execution: LiveWorkExecution;
    selections?: LiveWorkSelectionOption[];
  }>;
}): string {
  const payload: {
    request: string;
    workState: { mode: WorkSnapshot["mode"]; state: WorkSnapshot["state"]; activeTurn: boolean; queuedCount: number };
    recentContext?: Array<{ role: "user" | "assistant"; text: string }>;
    availableSelections?: LiveWorkSelectionOption[];
    pendingQuestion?: LiveWorkPendingQuestion;
  } = {
    request: input.candidate.instruction,
    workState: {
      mode: input.snapshot.mode,
      state: input.snapshot.state,
      activeTurn: Boolean(input.snapshot.activeTurnId),
      queuedCount: input.snapshot.queue.length,
    },
    ...(input.recentOperations?.length
      ? {
          recentOperations: input.recentOperations.slice(-8).map(({ operationId, admission, execution }) => ({
            operationId,
            admission,
            execution,
          })),
        }
      : {}),
  };

  const latestSelectionOperation = [...(input.recentOperations ?? [])].reverse()
    .find((operation) => operation.selections?.length);
  if (latestSelectionOperation?.selections?.length) {
    payload.availableSelections = latestSelectionOperation.selections.slice(0, 20);
  }

  // The pending question is what a spoken answer has to be checked against:
  // without its own option labels in the input, the classifier could only
  // guess, so it travels with the request.
  if (input.pendingQuestion) payload.pendingQuestion = input.pendingQuestion;

  if (input.contextEnabled) {
    const messages = (input.recentMessages ?? [])
      .filter((message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        !message.voiceOrigin &&
        !message.toolName &&
        !message.parentToolCallId &&
        !message.attachments?.length,
      )
      .slice(-6)
      .map((message) => ({ role: message.role as "user" | "assistant", text: message.content.trim() }))
      .filter((message) => message.text.length > 0);
    let recentBytes = 0;
    const bounded = messages.reverse().filter((message) => {
      const size = new TextEncoder().encode(message.text).byteLength;
      if (recentBytes + size > MAX_RECENT_TRANSCRIPT_BYTES) return false;
      recentBytes += size;
      return true;
    }).reverse();
    if (bounded.length) payload.recentContext = bounded;
  }

  let serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CLASSIFIER_CONTEXT_BYTES) {
    delete payload.recentContext;
    serialized = JSON.stringify(payload);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CLASSIFIER_CONTEXT_BYTES && payload.availableSelections) {
    payload.availableSelections = payload.availableSelections.slice(0, 5).map((selection) => ({
      ...selection,
      label: selection.label.slice(0, 48),
    }));
    serialized = JSON.stringify(payload);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CLASSIFIER_CONTEXT_BYTES) {
    delete payload.availableSelections;
    serialized = JSON.stringify(payload);
  }
  return serialized;
}
