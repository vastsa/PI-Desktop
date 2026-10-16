import { useEffect, useRef, useState } from "react";
import {
  appendTokenSample,
  calculateWindowedTokenRate,
  resolveStreamingOutputTokens,
  shouldResetTokenRateWindow,
  type TokenRateSample,
} from "../../../../lib/streaming-token-rate";

export type LiveTokenRate = {
  tokensPerSecond: number | undefined;
  estimated: boolean;
};

const IDLE_RATE: LiveTokenRate = {
  tokensPerSecond: undefined,
  estimated: false,
};

/**
 * Sample the active turn's output tokens on a short interval and expose a
 * sliding-window tok/s reading for the transcript stream-health strip.
 *
 * Latest content / thinking / outputTokens live in refs so the interval is
 * not torn down on every stream delta — only `active` / `tickMs` restart it.
 */
export function useLiveTokenRate(input: {
  active: boolean;
  content?: string;
  thinking?: string;
  outputTokens?: number;
  tickMs?: number;
}): LiveTokenRate {
  const [rate, setRate] = useState<LiveTokenRate>(IDLE_RATE);
  const samplesRef = useRef<TokenRateSample[]>([]);
  const estimatedRef = useRef(false);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    if (!input.active) {
      samplesRef.current = [];
      estimatedRef.current = false;
      setRate(IDLE_RATE);
      return;
    }

    const sample = () => {
      const current = inputRef.current;
      const nowMs = Date.now();
      const resolved = resolveStreamingOutputTokens({
        outputTokens: current.outputTokens,
        content: current.content,
        thinking: current.thinking,
      });
      const last = samplesRef.current[samplesRef.current.length - 1];
      if (
        shouldResetTokenRateWindow({
          wasEstimated: estimatedRef.current,
          nowEstimated: resolved.estimated,
          previousTokens: last?.tokens,
          nextTokens: resolved.tokens,
        })
      ) {
        samplesRef.current = [];
      }
      estimatedRef.current = resolved.estimated;
      samplesRef.current = appendTokenSample(
        samplesRef.current,
        { atMs: nowMs, tokens: resolved.tokens },
        nowMs,
      );
      setRate({
        tokensPerSecond: calculateWindowedTokenRate(
          samplesRef.current,
          nowMs,
        ),
        estimated: resolved.estimated,
      });
    };

    sample();
    const timer = window.setInterval(sample, input.tickMs ?? 250);
    return () => window.clearInterval(timer);
  }, [input.active, input.tickMs]);

  return input.active ? rate : IDLE_RATE;
}
