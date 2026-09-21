import { create } from "zustand";
import type { ReviewFeedback } from "../../../lib/review-feedback";

type FeedbackDrafts = { drafts: ReadonlyMap<string, ReviewFeedback> };
export const useReviewFeedbackDrafts = create<FeedbackDrafts>(() => ({
  drafts: new Map(),
}));

export function readReviewFeedback(
  sessionId: string,
  workspacePath: string,
): ReviewFeedback | undefined {
  const feedback = useReviewFeedbackDrafts.getState().drafts.get(sessionId);
  return feedback?.workspacePath === workspacePath ? feedback : undefined;
}

/** One pending comment per session. Never replace an unsent comment implicitly. */
export function stageReviewFeedback(feedback: ReviewFeedback): boolean {
  if (readReviewFeedback(feedback.sessionId, feedback.workspacePath))
    return false;
  const drafts = new Map(useReviewFeedbackDrafts.getState().drafts);
  drafts.set(feedback.sessionId, feedback);
  useReviewFeedbackDrafts.setState({ drafts });
  return true;
}

export function clearReviewFeedback(sessionId: string): void {
  const drafts = new Map(useReviewFeedbackDrafts.getState().drafts);
  if (!drafts.delete(sessionId)) return;
  useReviewFeedbackDrafts.setState({ drafts });
}

export function pruneReviewFeedback(sessionIds: readonly string[]): void {
  const keep = new Set(sessionIds);
  const drafts = new Map(useReviewFeedbackDrafts.getState().drafts);
  for (const id of drafts.keys()) if (!keep.has(id)) drafts.delete(id);
  if (drafts.size !== useReviewFeedbackDrafts.getState().drafts.size)
    useReviewFeedbackDrafts.setState({ drafts });
}
