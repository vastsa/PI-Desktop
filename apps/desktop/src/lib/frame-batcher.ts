type FrameHandle = number;

/**
 * Coalesces high-frequency updates until the next paint opportunity.
 *
 * A key keeps only the latest value for one streaming target while preserving
 * insertion order between different targets. Terminal events can call
 * flushNow() so a final state never waits behind the frame.
 */
export function createFrameBatcher<T>(
  flush: (values: readonly T[]) => void,
) {
  const pending = new Map<string, T>();
  let handle: FrameHandle | null = null;
  let usesAnimationFrame = false;

  const cancelScheduledFlush = () => {
    if (handle === null) return;
    if (
      usesAnimationFrame &&
      typeof globalThis.cancelAnimationFrame === "function"
    ) {
      globalThis.cancelAnimationFrame(handle);
    } else {
      globalThis.clearTimeout(handle);
    }
    handle = null;
  };

  const run = () => {
    handle = null;
    if (pending.size === 0) return;
    const values = [...pending.values()];
    pending.clear();
    flush(values);
  };

  const schedule = () => {
    if (handle !== null) return;
    if (typeof globalThis.requestAnimationFrame === "function") {
      usesAnimationFrame = true;
      handle = globalThis.requestAnimationFrame(run);
      return;
    }
    usesAnimationFrame = false;
    handle = globalThis.setTimeout(run, 16) as unknown as FrameHandle;
  };

  return {
    enqueue(key: string, value: T) {
      pending.set(key, value);
      schedule();
    },
    flushNow() {
      cancelScheduledFlush();
      run();
    },
    get size() {
      return pending.size;
    },
  };
}
