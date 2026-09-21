import { create } from "zustand";

type ReviewFocus = {
  sessionId: string;
  workspacePath: string;
  snapshotId: string;
  sequence: number;
};
export const useReviewNavigation = create<{ focus: ReviewFocus | null }>(
  () => ({ focus: null }),
);

export function focusReviewChange(
  sessionId: string,
  workspacePath: string,
  snapshotId: string,
): void {
  useReviewNavigation.setState((state) => ({
    focus: {
      sessionId,
      workspacePath,
      snapshotId,
      sequence: (state.focus?.sequence ?? 0) + 1,
    },
  }));
}
