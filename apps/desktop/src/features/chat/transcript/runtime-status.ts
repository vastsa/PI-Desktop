export type TranscriptRuntimeIndicator = "activity" | "planning" | "working" | undefined;

export function transcriptRuntimeIndicator(input: {
  showStatus: boolean;
  mode?: string;
  planningState?: string;
  hasSpecializedActivity: boolean;
}): TranscriptRuntimeIndicator {
  if (!input.showStatus) return undefined;
  if (input.hasSpecializedActivity) return "activity";
  if (input.mode === "plan" && input.planningState === "planning") {
    return "planning";
  }
  return "working";
}
