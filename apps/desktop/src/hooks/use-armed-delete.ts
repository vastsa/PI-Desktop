import { useEffect, useState } from "react";

/** How long an armed delete stays armed before it disarms itself. */
export const ARMED_DELETE_MS = 3200;

/**
 * A delete that needs two clicks. The first click arms the action and the
 * caller relabels it; the arm expires on its own so a surface never stays one
 * stray click away from a permanent delete. The armed key is opaque to the
 * hook, so a caller can arm either a row or one item of a row menu.
 */
export function useArmedDelete(timeoutMs: number = ARMED_DELETE_MS) {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), timeoutMs);
    return () => clearTimeout(timer);
  }, [armed, timeoutMs]);
  return { armed, setArmed };
}
