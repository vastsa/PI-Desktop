export type PowerSaveBlockerKind = "prevent-app-suspension" | "prevent-display-sleep";

type PowerSaveBlocker = {
  start: (kind: PowerSaveBlockerKind) => number;
  stop: (id: number) => void;
  isStarted?: (id: number) => boolean;
};

/** Owns one Electron blocker for one independent power setting. */
export function createPowerSaveBlockerController(
  blocker: PowerSaveBlocker,
  kind: PowerSaveBlockerKind,
  onError: (operation: "start" | "stop", error: unknown) => void = () => {},
) {
  let enabled = false;
  let disposed = false;
  let blockerId: number | null = null;

  const stop = () => {
    if (blockerId === null) return;
    const id = blockerId;
    blockerId = null;
    try {
      if (blocker.isStarted?.(id) !== false) blocker.stop(id);
    } catch (error) {
      onError("stop", error);
    }
  };

  const reconcile = () => {
    if (disposed || !enabled) {
      stop();
      return;
    }
    if (blockerId !== null) return;
    try {
      blockerId = blocker.start(kind);
    } catch (error) {
      onError("start", error);
    }
  };

  return {
    reconcile,
    setEnabled(value: boolean) {
      if (disposed) return;
      enabled = value;
      reconcile();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
