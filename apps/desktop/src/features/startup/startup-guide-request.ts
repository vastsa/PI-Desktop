import { create } from "zustand";

/**
 * A user request to replay the startup guide (Settings → About). Kept apart
 * from the automatic first-launch decision: a replay never touches the
 * "guide completed" marker.
 */
export const useStartupGuideRequest = create<{
  requested: boolean;
  request: () => void;
  clear: () => void;
}>((set) => ({
  requested: false,
  request: () => set({ requested: true }),
  clear: () => set({ requested: false }),
}));
