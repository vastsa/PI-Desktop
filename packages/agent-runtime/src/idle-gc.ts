/**
 * Periodic heap trim for the agent sidecar.
 *
 * V8 keeps promoted old-space pages resident after large turns, so an
 * otherwise idle sidecar pins its peak RSS long after the last prompt
 * (issue #1496). A full GC while every session family is idle hands those
 * pages back to the OS.
 *
 * The busy probes are a best-effort gate, not a synchronization primitive:
 * a turn starting between the probe and the gc() call may observe a brief
 * full-GC pause. At sidecar heap sizes that pause is tens of milliseconds
 * at most, which is why the gate is worth having but does not need to be
 * airtight.
 */

export interface IdleHeapTrimOptions {
  /** Run a full garbage collection. */
  gc: () => void;
  /**
   * Busy probes, one per session family (DesktopAgentRuntime sessions and
   * native Pi sessions). The trim is skipped while any probe reports true.
   */
  busy: ReadonlyArray<() => boolean>;
  /** Trim interval in milliseconds. */
  intervalMs: number;
}

/**
 * Start the idle heap trim and return a stop function. The timer is
 * unref'd, so it never keeps the process alive by itself. A throwing gc()
 * or probe is swallowed: a failed trim must never take the sidecar down.
 */
export function startIdleHeapTrim(options: IdleHeapTrimOptions): () => void {
  const timer = setInterval(() => {
    try {
      if (options.busy.some((probe) => probe())) return;
      options.gc();
    } catch {
      // Best-effort trim; never fatal.
    }
  }, options.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
