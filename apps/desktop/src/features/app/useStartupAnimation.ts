import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  STARTUP_ANIMATION_FIRST_FRAME_TIMEOUT_MS,
  STARTUP_ANIMATION_HOLD_HINT_MS,
  STARTUP_ANIMATION_MAX_DURATION_MS,
} from "@pi-desktop/shared";
import {
  INITIAL_STARTUP_ANIMATION_STATE,
  REVEAL_MS,
  reduceStartupAnimation,
  shouldPlayStartupAnimation,
  STARTUP_ANIMATION_PLAYED_KEY,
  type StartupAnimationEndReason,
  type StartupAnimationPhase,
} from "../../lib/startup-animation";

/**
 * Drive the user's boot animation (D679 / ADR 0338).
 *
 * The decision to play is made once, during the first render, because the
 * descriptor is already on `window.piDesktop` before the first paint and the
 * surface must be in that paint. Everything after that is bounded: the first
 * frame, the whole playback, and the reveal each have a timer, so no state the
 * video element can get into leaves the window behind an opaque mask.
 */

export type StartupAnimationState = {
  /** The animation owns the boot surface; the brand splash stays unmounted. */
  active: boolean;
  phase: StartupAnimationPhase;
  /** True while the `<video>` should be mounted and playing. */
  playing: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The hold has outlasted its quiet bound; show the progress affordance. */
  holdingLong: boolean;
  /** Attach to the element: the first decoded frame cancels its own bound. */
  onFirstFrame: () => void;
  /** Attach to `ended`; also the error and skip path. */
  onAnimationEnd: (reason: StartupAnimationEndReason) => void;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Whether this window already spent its animation.
 *
 * `sessionStorage` rather than a module variable: a renderer reload re-runs the
 * module but keeps the storage, which is exactly the boundary wanted here — one
 * animation per window, not one per script evaluation.
 */
function readPlayed(): boolean {
  try {
    return window.sessionStorage.getItem(STARTUP_ANIMATION_PLAYED_KEY) === "1";
  } catch {
    // A renderer without storage access is still allowed to play; the main
    // process has already limited the descriptor to the first window.
    return false;
  }
}

function markPlayed(): void {
  try {
    window.sessionStorage.setItem(STARTUP_ANIMATION_PLAYED_KEY, "1");
  } catch {
    // Non-fatal: the worst case is a replay after a manual reload.
  }
}

/**
 * This page load's verdict, decided once.
 *
 * The decision has a side effect — it marks the animation as spent — so it
 * cannot be re-evaluated. `StrictMode` invokes a `useState` initializer twice
 * in development and keeps the second result, which without this memo would
 * read back the mark the first invocation just wrote and answer "already
 * played": the animation would never appear in a development build.
 *
 * Module scope is the right lifetime. It is reset by a reload, and a reload is
 * exactly what the `sessionStorage` mark is there to catch.
 */
let pageLoadVerdict: boolean | null = null;

function decidePlayback(
  descriptor: ReturnType<typeof readDescriptor>,
): boolean {
  if (pageLoadVerdict !== null) return pageLoadVerdict;
  const surface = new URLSearchParams(window.location.search).get("surface");
  const play = shouldPlayStartupAnimation({
    descriptor,
    surface,
    reduceMotion: prefersReducedMotion(),
    played: readPlayed(),
  });
  if (play) markPlayed();
  pageLoadVerdict = play;
  return play;
}

function readDescriptor() {
  if (typeof window === "undefined") return null;
  return window.piDesktop?.startupAnimation ?? null;
}

export function useStartupAnimation(ready: boolean): StartupAnimationState {
  const descriptor = useMemo(readDescriptor, []);
  const [active] = useState(() => decidePlayback(descriptor));
  const skipWhenReady = descriptor?.skipWhenReady === true;
  const [state, setState] = useState(INITIAL_STARTUP_ANIMATION_STATE);
  const [holdingLong, setHoldingLong] = useState(false);
  // `ready` is read inside the reducer rules, which the event callbacks close
  // over; a ref keeps those callbacks stable without going stale.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const dispatch = useCallback(
    (event: Parameters<typeof reduceStartupAnimation>[1]) => {
      setState((current) =>
        reduceStartupAnimation(current, event, {
          skipWhenReady,
          ready: readyRef.current,
        }),
      );
    },
    [skipWhenReady],
  );

  const onAnimationEnd = useCallback(
    (reason: StartupAnimationEndReason) => {
      dispatch({ kind: "animation-ended", reason });
    },
    [dispatch],
  );

  // The first decoded frame retires the only bound that can fire before the
  // animation is visible at all.
  const videoRef = useRef<HTMLVideoElement>(null);
  const firstFrameRef = useRef(false);
  const onFirstFrame = useCallback(() => {
    firstFrameRef.current = true;
  }, []);

  // A file that is readable but not playable leaves `<video>` silent: no
  // `ended`, no `error`. Without this bound the window sits on an empty black
  // surface until the watchdog's 180s recovery bound, which is three minutes of
  // nothing for what is really a bad export.
  useEffect(() => {
    if (!active || state.phase !== "video") return;
    const firstFrame = window.setTimeout(() => {
      // Media events can precede their React handlers; inspect the decoded frame too.
      if (!firstFrameRef.current && (videoRef.current?.readyState ?? 0) < HTMLMediaElement.HAVE_CURRENT_DATA) {
        onAnimationEnd("no-first-frame");
      }
    }, STARTUP_ANIMATION_FIRST_FRAME_TIMEOUT_MS);
    const maxDuration = window.setTimeout(() => {
      onAnimationEnd("max-duration");
    }, STARTUP_ANIMATION_MAX_DURATION_MS);
    return () => {
      window.clearTimeout(firstFrame);
      window.clearTimeout(maxDuration);
    };
  }, [active, state.phase, onAnimationEnd]);

  useEffect(() => {
    if (!active || !ready) return;
    dispatch({ kind: "shell-ready" });
  }, [active, ready, dispatch]);

  useEffect(() => {
    if (!active || state.phase !== "reveal") return;
    const timer = window.setTimeout(() => {
      dispatch({ kind: "reveal-finished" });
    }, REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [active, state.phase, dispatch]);

  // An opaque mask is indistinguishable from a hang, so a hold that outlasts
  // its quiet bound earns the splash's progress affordance. The real failure
  // bounds stay with the startup watchdog.
  useEffect(() => {
    if (!active || state.phase !== "hold") {
      setHoldingLong(false);
      return;
    }
    const timer = window.setTimeout(
      () => setHoldingLong(true),
      STARTUP_ANIMATION_HOLD_HINT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [active, state.phase]);

  // Escape is the escape hatch for a long animation someone has seen enough
  // times. It jumps to the reveal rather than cutting to the shell, so the
  // transition is the same one every launch ends with.
  useEffect(() => {
    if (!active || state.phase === "done") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onAnimationEnd("skipped");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, state.phase, onAnimationEnd]);

  return {
    active: active && state.phase !== "done",
    phase: state.phase,
    playing: active && state.phase === "video",
    videoRef,
    holdingLong,
    onFirstFrame,
    onAnimationEnd,
  };
}
