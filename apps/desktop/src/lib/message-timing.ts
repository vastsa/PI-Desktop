/**
 * Pure formatting helpers for the transcript's per-reply readout.
 *
 * They live outside `features/chat/transcript/shared.tsx` on purpose: that
 * module also exports React components, so importing a formatter from it drags
 * the component graph into every consumer — including the presentation tests
 * that stub it by hand.
 */
import { formatToolDuration } from "./tool-display";

/**
 * Local clock time for a transcript timestamp. One formatter is hoisted: the
 * footer renders on every completed reply, and constructing one per call is
 * measurably wasteful in a long transcript.
 */
const clockTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatClockTime(iso: string): string | undefined {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? clockTimeFormat.format(at) : undefined;
}

/**
 * Elapsed milliseconds between two ISO timestamps, or undefined when either is
 * missing, unparseable, or out of order.
 */
export function elapsedBetween(
  from: string | undefined,
  to: string | undefined,
): number | undefined {
  if (!from || !to) return undefined;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}

/**
 * A duration for the timing readout. Sub-second precision is the point of a
 * first-token latency, so short waits keep one decimal where the whole-second
 * tool formatter would print "0s".
 */
export function formatTimingDuration(ms: number): string {
  if (Math.abs(ms) < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatToolDuration(ms / 1000);
}
