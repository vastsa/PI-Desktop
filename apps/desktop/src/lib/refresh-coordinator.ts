type RefreshBatch<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createBatch<T>(): RefreshBatch<T> {
  let resolve!: RefreshBatch<T>["resolve"];
  let reject!: RefreshBatch<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Start idle reads immediately and merge in-flight invalidations into one
 * trailing read. A later caller must not receive a snapshot requested before
 * its mutation. The callback owns committing each response exactly once.
 */
export function createRefreshCoordinator<T>(
  refresh: () => Promise<T>,
): () => Promise<T> {
  let active = false;
  let pending: RefreshBatch<T> | undefined;

  async function run(batch: RefreshBatch<T>): Promise<void> {
    try {
      batch.resolve(await refresh());
    } catch (error) {
      batch.reject(error);
    } finally {
      const next = pending;
      pending = undefined;
      if (next) void run(next);
      else active = false;
    }
  }

  return () => {
    if (active) {
      pending ??= createBatch<T>();
      return pending.promise;
    }
    const batch = createBatch<T>();
    active = true;
    void run(batch);
    return batch.promise;
  };
}
