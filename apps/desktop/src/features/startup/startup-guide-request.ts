import { create } from "zustand";
import type { StarAiCatalog } from "@pi-desktop/shared";

/**
 * Renderer-side requests that steer the startup overlays from outside the
 * host component:
 * - `requested`: the user asked to replay the startup guide (Settings → Info).
 * - `suppressed`: automation (`window.__PI_DESKTOP__.skipStartupOverlays`)
 *   drives a fresh profile and must not be covered by first-run overlays.
 *   Nothing is recorded as seen, so the real user flow is unchanged.
 */
export const useStartupGuideRequest = create<{
  requested: boolean;
  suppressed: boolean;
  starAiSetup: { catalog: StarAiCatalog | null } | null;
  setStarAiSetup: (request: { catalog: StarAiCatalog | null } | null) => void;
  request: () => void;
  clear: () => void;
  suppress: () => void;
}>((set) => ({
  requested: false,
  suppressed: false,
  starAiSetup: null,
  setStarAiSetup: (starAiSetup) => set({ starAiSetup }),
  request: () => set({ requested: true }),
  clear: () => set({ requested: false }),
  suppress: () => set({ suppressed: true }),
}));
