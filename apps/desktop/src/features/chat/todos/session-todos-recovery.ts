import type { HostStatusEvent, SessionTodoSnapshot } from "@pi-desktop/shared";

type RecoveryDependencies = {
  getTodos: (sessionId: string) => Promise<SessionTodoSnapshot>;
  onHostStatus: (listener: (status: HostStatusEvent) => void) => () => void;
  applySnapshot: (snapshot: SessionTodoSnapshot) => void;
  reportError: (error: unknown) => void;
};

/** Recover committed host state on activation and backend restoration. */
export function startSessionTodosRecovery(
  sessionId: string,
  { getTodos, onHostStatus, applySnapshot, reportError }: RecoveryDependencies,
): () => void {
  if (sessionId.startsWith("remote:") || sessionId.startsWith("native-pi:")) {
    return () => undefined;
  }

  let disposed = false;
  let generation = 0;
  let hostUnavailable = false;
  const refresh = async () => {
    const requestGeneration = ++generation;
    try {
      const snapshot = await getTodos(sessionId);
      if (disposed || requestGeneration !== generation) return;
      if (snapshot.sessionId !== sessionId) {
        reportError(new Error("Checklist recovery returned a different session"));
        return;
      }
      // The store's revision fence also protects against a newer push event
      // arriving while this read is pending.
      applySnapshot(snapshot);
    } catch (error) {
      if (!disposed && requestGeneration === generation) {
        hostUnavailable = true;
        reportError(error);
      }
    }
  };
  const unsubscribe = onHostStatus((status) => {
    if (status.component === "sidecar") return;
    if (!status.ok) {
      hostUnavailable = true;
      // Responses from the lost host generation cannot complete recovery.
      generation++;
      return;
    }
    if (hostUnavailable || status.restarted) {
      hostUnavailable = false;
      void refresh();
    }
  });
  // Subscribe before the first read so a restore event cannot be missed.
  void refresh();
  return () => {
    disposed = true;
    generation++;
    unsubscribe();
  };
}
