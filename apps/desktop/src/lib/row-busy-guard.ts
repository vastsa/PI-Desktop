/**
 * Busy-key bookkeeping for row-keyed operations, free of React so tests can
 * drive the guard directly.
 *
 * One shared `busyId` slot cannot guard rows that run concurrently: the first
 * request to settle clears the slot while other rows are still in flight, so
 * those rows lose both their busy marker and their double-click guard. One
 * independent key per row keeps every row protected without serializing the
 * page.
 */
export type RowBusyGuard = {
  /** Claim one row's slot; false when that row is already busy. */
  begin: (key: string) => boolean;
  /** Release one row's slot; safe to call when nothing claimed it. */
  end: (key: string) => void;
  isBusy: (key: string) => boolean;
};

export function createRowBusyGuard(): RowBusyGuard {
  const busy = new Set<string>();
  return {
    begin: (key) => {
      if (busy.has(key)) return false;
      busy.add(key);
      return true;
    },
    end: (key) => {
      busy.delete(key);
    },
    isBusy: (key) => busy.has(key),
  };
}
