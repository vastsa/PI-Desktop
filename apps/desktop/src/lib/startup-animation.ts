/**
 * Phase machine for the user-supplied boot animation (D679 / ADR 0338).
 *
 * The animation replaces the brand splash as the boot surface, so the one
 * question it has to answer correctly is *when the shell becomes visible*. Two
 * independent things end: the video reaches its last frame, and the shell
 * receives its initial state. The reveal waits for both, which is what makes
 * the sequence the user asked for — play, then black, then fade — rather than a
 * fade that lands on a half-built window.
 *
 * Kept free of React and of the clock so every transition is testable without
 * a renderer: the hook supplies the events, this decides the phase.
 */

import {
  STARTUP_ANIMATION_REVEAL_MS,
  type StartupAnimationDescriptor,
} from "@pi-desktop/shared";

/**
 * - `video`: the animation is playing over black.
 * - `hold`: the animation finished, the shell has no state yet, the mask is
 *   opaque black.
 * - `reveal`: the mask is fading out; the shell underneath already takes input.
 * - `done`: the surface is gone.
 */
export type StartupAnimationPhase = "video" | "hold" | "reveal" | "done";

/** Why the animation stopped; carried for diagnostics, not for rendering. */
export type StartupAnimationEndReason =
  | "ended"
  | "error"
  | "no-first-frame"
  | "max-duration"
  | "skipped"
  | "ready";

export type StartupAnimationState = {
  phase: StartupAnimationPhase;
  /** Set once the animation stops, whichever bound stopped it. */
  endReason: StartupAnimationEndReason | null;
};

export type StartupAnimationEvent =
  | { kind: "animation-ended"; reason: StartupAnimationEndReason }
  | { kind: "shell-ready" }
  | { kind: "reveal-finished" };

export const INITIAL_STARTUP_ANIMATION_STATE: StartupAnimationState = {
  phase: "video",
  endReason: null,
};

export type StartupAnimationRules = {
  /** `descriptor.skipWhenReady`: a fast boot may cut the playback short. */
  skipWhenReady: boolean;
  /** The shell already published its initial state. */
  ready: boolean;
};

/**
 * Advance the phase.
 *
 * Deliberately total and monotonic: every phase only ever moves forward, so a
 * late `animation-ended` from a video element that was already abandoned, or a
 * second `shell-ready` from a re-render, cannot pull the surface back over a
 * shell the user is already using.
 */
export function reduceStartupAnimation(
  state: StartupAnimationState,
  event: StartupAnimationEvent,
  rules: StartupAnimationRules,
): StartupAnimationState {
  if (state.phase === "done") return state;
  switch (event.kind) {
    case "animation-ended": {
      if (state.phase !== "video") return state;
      const endReason = state.endReason ?? event.reason;
      // Already-ready boots skip the black hold entirely; there is nothing left
      // to wait for, and a mandatory beat of black would read as a stutter.
      return { phase: rules.ready ? "reveal" : "hold", endReason };
    }
    case "shell-ready": {
      if (state.phase === "hold") {
        return { phase: "reveal", endReason: state.endReason };
      }
      if (state.phase === "video" && rules.skipWhenReady) {
        return { phase: "reveal", endReason: state.endReason ?? "ready" };
      }
      return state;
    }
    case "reveal-finished": {
      if (state.phase !== "reveal") return state;
      return { phase: "done", endReason: state.endReason };
    }
  }
}

/**
 * Whether this renderer should play the animation at all.
 *
 * `played` is the reload guard: the descriptor rides on a window creation
 * argument, so it survives a renderer reload that the user triggered long after
 * the launch. Replaying a cinematic over a window someone was working in would
 * be worse than skipping it.
 *
 * Reduced motion drops the animation rather than shortening it. A boot video is
 * motion the user cannot opt out of once it starts, and the OS-level request is
 * exactly that opt-out.
 */
export function shouldPlayStartupAnimation(input: {
  descriptor: StartupAnimationDescriptor | null | undefined;
  /** Renderer surface query parameter; only the main window plays it. */
  surface: string | null;
  reduceMotion: boolean;
  played: boolean;
}): boolean {
  if (!input.descriptor) return false;
  if (input.surface) return false;
  if (input.reduceMotion) return false;
  return !input.played;
}

/** `sessionStorage` key marking the animation as spent for this window. */
export const STARTUP_ANIMATION_PLAYED_KEY = "pi-desktop.startup-animation.played";

/**
 * Milliseconds the reveal fade takes, matching the CSS transition.
 *
 * Re-exported so the hook and the stylesheet are read from one number; the
 * surface unmounts on this timer rather than on `transitionend`, which never
 * fires if the element is hidden mid-fade.
 */
export const REVEAL_MS = STARTUP_ANIMATION_REVEAL_MS;
