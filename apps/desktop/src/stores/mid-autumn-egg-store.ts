import { create } from "zustand";

/**
 * Whether the full-screen Mid-Autumn overlay is showing. `show` is used both
 * for the once-only launch replay and for the manual replay in Settings.
 */
export const useMidAutumnEggStore = create<{
  open: boolean;
  show: () => void;
  hide: () => void;
}>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
