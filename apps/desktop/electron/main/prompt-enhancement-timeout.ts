/**
 * Bound one prompt-enhancement request.
 *
 * The transport only consults its abort signal between provider retries, so
 * aborting is best-effort cancellation. Racing the promise is what actually
 * guarantees the caller is released: without it a stalled connection or a slow
 * gateway holds the renderer's promise open indefinitely, and the provider
 * retry budget alone can already spend about a minute before giving up.
 *
 * The helper still aborts: a timeout that only races leaves the provider call
 * running, which burns tokens and can overlap the user's next click.
 *
 * Kept in its own module (no Electron or pi-ai imports) so the behavior is
 * directly testable.
 */

/** Hard ceiling for one enhancement request. */
export const PROMPT_ENHANCEMENT_TIMEOUT_MS = 60_000;

/** Classified timeout failure the renderer renders as a dismissible error. */
export type PromptEnhancementTimeoutError = Error & {
  errorCode: "TIMEOUT";
};

export function promptEnhancementTimeoutError(
  timeoutMs: number,
): PromptEnhancementTimeoutError {
  return Object.assign(
    new Error(
      `Prompt enhancement timed out after ${Math.round(timeoutMs / 1000)}s. Try again, or pick a faster enhancement model in Settings.`,
    ),
    { errorCode: "TIMEOUT" as const },
  );
}

/**
 * Run `start` with an abort signal, or reject with `TIMEOUT` after `timeoutMs`.
 *
 * A failure from `start` itself passes through unchanged; only an unanswered
 * request becomes a timeout. Abort after timeout is best-effort; the race is
 * what frees the caller. The rejection is never retried on another model:
 * the user chose this one, and a hidden second attempt would double the wait.
 */
export function withPromptEnhancementTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = PROMPT_ENHANCEMENT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const work = start(controller.signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(promptEnhancementTimeoutError(timeoutMs)));
    }, timeoutMs);
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => {
        if (controller.signal.aborted) return;
        finish(() => reject(error));
      },
    );
  });
}
