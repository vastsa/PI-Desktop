import { useCallback, useEffect, useRef, useState } from "react";
import {
  createStartupWatchdog,
  type StartupPhase,
} from "../../lib/startup-watchdog";
import { useAppStore } from "../../stores/app-store";

const clockNow = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** How stuck a phase reads; a wait never looks better than it already did. */
const PHASE_RANK: Record<StartupPhase, number> = {
  starting: 0,
  slow: 1,
  stalled: 2,
};

export type StartupWatchdogState = {
  /** Where the wait for the first state currently is. */
  phase: StartupPhase;
  /** Milliseconds waited so far, read on demand (never during render). */
  waitedMs: () => number;
  /** A retry is in flight and has not run out its own bounds yet. */
  retrying: boolean;
  /**
   * Ask for the initial state again after a stalled boot. The watchdog restarts
   * with the attempt, so the retry gets its own full window before it is called
   * stalled again.
   */
  retry: () => void;
};

/**
 * Watch the initial-state wait and report it as it ages.
 *
 * The watchdog never cancels the startup it watches: a slow launch that does
 * finish still flips `ready` and takes the window over, which is why the phase
 * resets as soon as it does. Failure to reach the first state at all is the case
 * issue #831 reports, and that is the one the caller renders a recovery surface
 * for.
 */
export function useStartupWatchdog(ready: boolean): StartupWatchdogState {
  const [phase, setPhase] = useState<StartupPhase>("starting");
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const startedAtRef = useRef(clockNow());

  useEffect(() => {
    if (ready) {
      // The initial state arrived: the wait is over, however it looked.
      retryingRef.current = false;
      setRetrying(false);
      setPhase("starting");
      return;
    }
    startedAtRef.current = clockNow();
    const watchdog = createStartupWatchdog({
      onPhase: (next) => {
        // A retry restarts the clock, not the story. Dropping back to
        // "starting" would hide the surface (and its retry) the user is standing
        // on, and the fresh attempt's own slow bound must not walk "stalled"
        // back to "slow" while nothing has actually improved. The stalled bound
        // is also where a retry stops counting as in flight, so the action is
        // offered again instead of staying disabled forever.
        if (next === "stalled") {
          retryingRef.current = false;
          setRetrying(false);
        }
        setPhase((current) =>
          PHASE_RANK[next] > PHASE_RANK[current] ? next : current,
        );
      },
      scheduler: {
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });
    watchdog.start();
    // The wait is over on either exit: the initial state arrived, the retry
    // restarted it, or the surface unmounted. Leaving either timer armed past
    // that would publish a phase for an app that already has data.
    return () => watchdog.stop();
  }, [ready, attempt]);

  const retry = useCallback(() => {
    // Every click would otherwise start another full startup (about ten reads
    // plus a model listing per provider) against a service that is already not
    // answering.
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setAttempt((current) => current + 1);
    // The store keeps only the newest attempt's result, so an older read that
    // finally lands cannot reset the view the retry already published.
    void useAppStore.getState().bootstrap();
  }, []);

  const waitedMs = useCallback(() => clockNow() - startedAtRef.current, []);

  return { phase, waitedMs, retrying, retry };
}
