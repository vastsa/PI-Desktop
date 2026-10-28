/**
 * Vocabulary and normalization for `AppSettings.radialMenu`, shared by the
 * renderer and Electron Main so both sides accept exactly the same values.
 */
import type {
  RadialMenuAction,
  RadialMenuDirection,
  RadialMenuPreferences,
} from "./types/settings.js";

/** Clockwise from the top, the order the ring renders and the keyboard walks. */
export const RADIAL_MENU_DIRECTIONS = [
  "up",
  "right",
  "down",
  "left",
] as const satisfies readonly RadialMenuDirection[];

export const RADIAL_MENU_ACTIONS = [
  "copy-conversation",
  "select-conversation",
  "copy-last-answer",
  "scroll-top",
  "scroll-bottom",
  "open-browser",
  "open-work-panel",
  "open-project-folder",
  "none",
] as const satisfies readonly RadialMenuAction[];

export const DEFAULT_RADIAL_MENU_SLOTS: Record<
  RadialMenuDirection,
  RadialMenuAction
> = {
  up: "copy-conversation",
  right: "select-conversation",
  down: "scroll-bottom",
  left: "scroll-top",
};

export function isRadialMenuAction(value: unknown): value is RadialMenuAction {
  return (
    typeof value === "string" &&
    (RADIAL_MENU_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Normalizes a whole preference for persistence. Unknown actions and a
 * non-boolean flag are dropped rather than copied forward, so a settings file
 * touched by a newer build keeps a shape this build can read.
 */
export function normalizeRadialMenuPreferences(
  value: unknown,
): RadialMenuPreferences {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const next: RadialMenuPreferences = {};
  if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
  for (const direction of RADIAL_MENU_DIRECTIONS) {
    if (isRadialMenuAction(raw[direction])) {
      next[direction] = raw[direction] as RadialMenuAction;
    }
  }
  return next;
}

/** True when the write carries a `radialMenu` field this build cannot read. */
export function radialMenuWriteError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "radialMenu is invalid";
  }
  const raw = value as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return "radialMenu.enabled is invalid";
  }
  for (const direction of RADIAL_MENU_DIRECTIONS) {
    if (raw[direction] !== undefined && !isRadialMenuAction(raw[direction])) {
      return `radialMenu.${direction} is invalid`;
    }
  }
  return null;
}
