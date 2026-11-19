import { create } from "zustand";

/**
 * Renderer-side requests that steer the startup overlays from outside the
 * host component:
 * - `requested`: the user asked to replay the startup guide (Settings → Info).
 *   A replay never touches the "guide completed" marker.
 * - `suppressed`: automation (`window.__PI_DESKTOP__.skipStartupOverlays`)
 *   drives a fresh profile and must not be covered by first-run overlays.
 *   Nothing is recorded as seen, so the real user flow is unchanged.
 */
export const useStartupGuideRequest = create<{
  requested: boolean;
  suppressed: boolean;
  request: () => void;
  clear: () => void;
  suppress: () => void;
}>((set) => ({
  requested: false,
  suppressed: false,
  request: () => set({ requested: true }),
  clear: () => set({ requested: false }),
  suppress: () => set({ suppressed: true }),
}));
