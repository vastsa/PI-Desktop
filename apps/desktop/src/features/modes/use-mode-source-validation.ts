import { useEffect, useRef, useState } from "react";
import type { ModeDocumentValidation } from "@pi-desktop/shared";
import { modesApi } from "./modes-api";

export const MODE_VALIDATION_DELAY_MS = 400;

/**
 * Debounced `modesValidate` for the source editor. Only the newest request
 * may answer, and an answer only applies to the exact text it checked, so a
 * slow reply never labels newer text. A failed request shows nothing rather
 * than a stale verdict.
 */
export function useModeSourceValidation(
  id: string | null,
  source: string,
  enabled: boolean,
  delayMs: number = MODE_VALIDATION_DELAY_MS,
): {
  validation: ModeDocumentValidation | null;
  pending: boolean;
  /** Record an answer that came from elsewhere (a rejected save). */
  record: (source: string, result: ModeDocumentValidation) => void;
} {
  // `result: null` records a failed request for that text.
  const [answer, setAnswer] = useState<{ source: string; result: ModeDocumentValidation | null } | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    if (!enabled || !id) return;
    const ticket = sequence.current;
    const timer = window.setTimeout(() => {
      void modesApi.validate({ id, source }).then(
        (result) => {
          if (ticket === sequence.current) setAnswer({ source, result });
        },
        (error: unknown) => {
          if (ticket !== sequence.current) return;
          console.warn("[modes] validation failed", error);
          setAnswer({ source, result: null });
        },
      );
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [id, source, enabled, delayMs]);

  const current = enabled && answer?.source === source ? answer : null;
  return {
    validation: current?.result ?? null,
    pending: enabled && !!id && !current,
    record: (checked, result) => setAnswer({ source: checked, result }),
  };
}
