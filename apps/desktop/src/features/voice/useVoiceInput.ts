/**
 * React hook managing voice input state and Composer integration.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { voiceIpc } from "./voice-ipc";

export type VoicePhase =
  | "idle"
  | "preparing"
  | "ready"
  | "starting"
  | "listening"
  | "transcribing"
  | "done"
  | "error"
  | "cancelling";

export interface VoiceState {
  phase: VoicePhase;
  durationSeconds: number;
  volumeLevel: number;
  error?: string;
  result?: {
    text: string;
    speechSeconds: number;
    transcribeSeconds: number;
    language: string;
  };
}

const IDLE_STATE: VoiceState = {
  phase: "idle",
  durationSeconds: 0,
  volumeLevel: 0,
};

interface UseVoiceInputOptions {
  /** Called when transcription completes with the resulting text. */
  onTranscriptionComplete?: (text: string) => void;
  /** Whether voice is enabled in settings. */
  enabled?: boolean;
}

export function useVoiceInput(options: UseVoiceInputOptions = {}) {
  const { onTranscriptionComplete, enabled = false } = options;
  const [state, setState] = useState<VoiceState>(IDLE_STATE);
  const onCompleteRef = useRef(onTranscriptionComplete);
  onCompleteRef.current = onTranscriptionComplete;

  // Listen for state changes from main process
  useEffect(() => {
    if (!enabled) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      timers.push(timer);
    };

    const unsubscribe = voiceIpc.onStateChanged((s) => {
      setState(s);

      // When transcription completes, call the callback
      if (s.phase === "done" && s.result?.text) {
        onCompleteRef.current?.(s.result.text);
        // Reset to idle after a short delay
        schedule(() => setState(IDLE_STATE), 100);
      }

      // Auto-reset error after 3 seconds
      if (s.phase === "error") {
        schedule(() => setState(IDLE_STATE), 3000);
      }
    });

    return () => {
      unsubscribe();
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [enabled]);

  const toggle = useCallback(async () => {
    if (!enabled) return;

    try {
      if (state.phase === "idle" || state.phase === "ready") {
        await voiceIpc.start();
      } else if (state.phase === "listening") {
        await voiceIpc.stop();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({
        phase: "error",
        durationSeconds: 0,
        volumeLevel: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [enabled, state.phase]);

  const cancel = useCallback(() => {
    if (!enabled) return;
    voiceIpc.cancel();
    setState(IDLE_STATE);
  }, [enabled]);

  const isActive =
    state.phase === "starting" ||
    state.phase === "listening" ||
    state.phase === "transcribing";

  return { state, toggle, cancel, isActive };
}
