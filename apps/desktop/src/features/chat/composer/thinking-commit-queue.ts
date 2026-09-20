/**
 * Latest-wins serial queue for composer thinking-level commits.
 *
 * A drag can cross several stops before an idle-session persist returns.
 * Only the newest pending value is sent after the in-flight write settles.
 * `invalidate` drops pending work so a model or session change cannot land
 * a stale level on the wrong binding.
 */
export function createLatestCommitQueue<T>(options: {
  send: (value: T) => Promise<void>;
  onError?: (error: unknown) => void;
}): {
  commit: (value: T) => Promise<boolean>;
  invalidate: () => void;
  idle: () => Promise<void>;
} {
  let pending: T | null = null;
  let generation = 0;
  let running = false;
  let idleWaiters: Array<() => void> = [];

  const notifyIdle = () => {
    if (running || pending !== null) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (pending !== null) {
        const gen = generation;
        const value = pending;
        pending = null;
        if (gen !== generation) break;
        try {
          await options.send(value);
        } catch (error) {
          generation += 1;
          pending = null;
          options.onError?.(error);
          break;
        }
        if (gen !== generation) break;
      }
    } finally {
      running = false;
      if (pending !== null) {
        void pump();
        return;
      }
      notifyIdle();
    }
  };

  const invalidate = () => {
    generation += 1;
    pending = null;
  };

  const whenIdle = () =>
    new Promise<void>((resolve) => {
      if (!running && pending === null) {
        resolve();
        return;
      }
      idleWaiters.push(resolve);
    });

  const commit = (value: T): Promise<boolean> => {
    pending = value;
    const enqueuedAt = generation;
    void pump();
    return whenIdle().then(() => generation === enqueuedAt);
  };

  return { commit, invalidate, idle: whenIdle };
}
