import { useEffect, useRef, useState } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import {
  LIVE_THROUGHPUT_SAMPLE_MS,
  liveTokenRate,
  pushThroughputSample,
  sampleTokensForMessage,
  type LiveTokenRate,
  type ThroughputSample,
} from "../../../lib/live-throughput";

/** Cadence that advances staleness while no tokens arrive. */
const TICK_MS = 1_000;

/**
 * Live tokens/s for the streaming message, sampled in a ref.
 *
 * The window is deliberately not store state. Writing a sample per coalesced
 * flush would notify every store subscriber, which is the sidebar re-render
 * ADR 0242 exists to prevent; a ref keeps the churn inside this component.
 *
 * Only ever mount this for the active tail turn. Hooks cannot be conditional,
 * so calling it from a shared row component would run a sampler and an interval
 * for every history row on screen.
 */
export function useLiveThroughput(
  message: Pick<UiMessage, "content" | "thinking"> | undefined,
): LiveTokenRate {
  const samplesRef = useRef<ThroughputSample[]>([]);
  const lastSampleAtRef = useRef(0);
  const [tick, setTick] = useState(() => Date.now());

  // Sampling walks the whole message to count code points, so it is throttled
  // rather than run on every 16ms flush.
  const now = Date.now();
  if (now - lastSampleAtRef.current >= LIVE_THROUGHPUT_SAMPLE_MS) {
    lastSampleAtRef.current = now;
    samplesRef.current = pushThroughputSample(samplesRef.current, {
      ts: now,
      tokens: sampleTokensForMessage(message),
    });
  }

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Streaming flushes re-render this component far faster than the interval;
  // the tick only matters once the stream goes quiet.
  return liveTokenRate(samplesRef.current, Math.max(now, tick));
}
