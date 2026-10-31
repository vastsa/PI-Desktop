import { create } from "zustand";

/** The one worktree dialog that is open, if any (ADR 0329). */
export type WorktreeDialog =
  | { kind: "merge"; sessionId: string; title: string }
  | { kind: "setupLog"; sessionId: string; title: string }
  | { kind: "setupCommand"; projectPath: string; projectName: string };

type WorktreeUiState = {
  dialog: WorktreeDialog | null;
  open: (dialog: WorktreeDialog) => void;
  close: () => void;
  /** Project commits each isolated session lacks, for the sidebar marker. */
  behind: Record<string, number>;
  setBehind: (counts: Record<string, number>) => void;
  setBehindFor: (sessionId: string, count: number) => void;
  /** Bumped after a merge or sync so the counts are read again. */
  behindRevision: number;
  refreshBehind: () => void;
};

/**
 * Dialog and "behind" state shared by the sidebar parts of isolated sessions.
 * Kept out of the central app store on purpose.
 */
export const useWorktreeUi = create<WorktreeUiState>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
  behind: {},
  setBehind: (counts) => set({ behind: counts }),
  setBehindFor: (sessionId, count) =>
    set((state) => (state.behind[sessionId] === count ? state : { behind: { ...state.behind, [sessionId]: count } })),
  behindRevision: 0,
  refreshBehind: () => set((state) => ({ behindRevision: state.behindRevision + 1 })),
}));
