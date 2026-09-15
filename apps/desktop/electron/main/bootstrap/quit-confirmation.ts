/** Serialize quit requests without treating an open dialog as consent. */
export function createQuitConfirmation({
  hasRunningTasks,
  confirm,
  accept,
  onError,
}: {
  hasRunningTasks: () => Promise<boolean>;
  confirm: () => Promise<boolean>;
  accept: () => void;
  onError: (error: unknown) => void;
}): () => Promise<void> {
  let pending = false;
  return async () => {
    if (pending) return;
    pending = true;
    try {
      if (!(await hasRunningTasks()) || (await confirm())) accept();
    } catch (error) {
      onError(error);
    } finally {
      pending = false;
    }
  };
}

/** Native Pi sessions are runtime-owned and do not enter Desktop's turn map. */
export async function hasRunningQuitTasks(
  activeTurns: ReadonlyMap<string, string>,
  listNativeSessions: () => Promise<{
    sessions: { capabilities?: { canStop?: boolean } }[];
  }>,
): Promise<boolean> {
  if (activeTurns.size > 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const native = await Promise.race([
      listNativeSessions(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runtime quit status timed out")), 2_000);
      }),
    ]);
    // A Desktop turn may have started while the native status was being read.
    return activeTurns.size > 0 || native.sessions.some((s) => s.capabilities?.canStop);
  } finally {
    clearTimeout(timer);
  }
}
