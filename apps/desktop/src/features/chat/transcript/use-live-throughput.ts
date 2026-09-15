import { useEffect, useRef, useState } from "react";
import {
  LIVE_THROUGHPUT_SAMPLE_MS,
  advanceThroughput,
  type LiveTokenRate,
  type ThroughputMessage,
  type ThroughputTracker,
} from "../../../lib/live-throughput";

/** Only the active turn mounts this sampler. Committed props feed a fixed cadence. */
export function useLiveThroughput(
  message: ThroughputMessage | undefined,
  generating: boolean,
): LiveTokenRate {
  const inputRef = useRef({ message, generating });
  const trackerRef = useRef<ThroughputTracker>({ samples: [] });
  const [view, setView] = useState<LiveTokenRate & { messageId?: string }>({ stale: false });

  useEffect(() => {
    inputRef.current = { message, generating };
  }, [message, generating]);

  useEffect(() => {
    const sample = () => {
      const input = inputRef.current;
      const next = advanceThroughput(
        trackerRef.current, input.message, input.generating, performance.now(),
      );
      trackerRef.current = next.tracker;
      setView((previous) =>
        previous.rate === next.view.rate && previous.stale === next.view.stale &&
        previous.messageId === input.message?.id
          ? previous
          : { ...next.view, messageId: input.message?.id },
      );
    };
    sample();
    const timer = window.setInterval(sample, LIVE_THROUGHPUT_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  return {
    rate: view.rate,
    stale: view.stale || !generating || view.messageId !== message?.id,
  };
}
