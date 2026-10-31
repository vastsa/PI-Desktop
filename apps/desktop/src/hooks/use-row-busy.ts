import { useCallback, useRef, useState } from "react";
import { createRowBusyGuard, type RowBusyGuard } from "../lib/row-busy-guard";

/**
 * Per-row busy guard for row-keyed async operations.
 *
 * A single shared `busyId` state breaks in both directions: whichever request
 * settles first clears the guard of rows still in flight (so a second click
 * can double-fire them), and guarding with `if (busyId)` serializes unrelated
 * rows into one global queue. One independent key per row keeps each row
 * double-click-safe while the others stay responsive. The guard logic itself
 * lives in `lib/row-busy-guard` so tests can drive it without a renderer.
 */
export function useRowBusy(): {
  isBusy: (key: string) => boolean;
  begin: (key: string) => boolean;
  end: (key: string) => void;
} {
  const guardRef = useRef<RowBusyGuard | null>(null);
  if (!guardRef.current) guardRef.current = createRowBusyGuard();
  const guard = guardRef.current;
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((count) => count + 1), []);
  const begin = useCallback(
    (key: string) => {
      const claimed = guard.begin(key);
      if (claimed) bump();
      return claimed;
    },
    [guard, bump],
  );
  const end = useCallback(
    (key: string) => {
      guard.end(key);
      bump();
    },
    [guard, bump],
  );
  // `revision` is a dependency on purpose: consumers re-render on every claim
  // and release without this hook exposing its Set.
  const isBusy = useCallback((key: string) => guard.isBusy(key), [guard, revision]);
  return { isBusy, begin, end };
}
