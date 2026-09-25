/**
 * Lightweight overlay shown above the Composer during voice input.
 */

import type { TFunction } from "i18next";
import type { VoiceState } from "./useVoiceInput";

interface VoiceOverlayProps {
  t: TFunction;
  state: VoiceState;
  onCancel: () => void;
}

export function VoiceOverlay({ t, state, onCancel }: VoiceOverlayProps) {
  if (
    state.phase !== "starting" &&
    state.phase !== "listening" &&
    state.phase !== "transcribing" &&
    state.phase !== "error"
  ) {
    return null;
  }

  return (
    <div className="voice-overlay" role="status" aria-live="polite">
      <div className="voice-overlay-content">
        <div className="voice-overlay-left">
          {state.phase === "listening" && (
            <>
              <span className="voice-recording-dot" aria-hidden="true" />
              <span>{t("settings.voiceRecording")}</span>
              <span className="voice-duration">
                {formatDuration(state.durationSeconds)}
              </span>
            </>
          )}
          {state.phase === "starting" && <span>{t("settings.voiceRecording")}</span>}
          {state.phase === "transcribing" && (
            <>
              <span className="voice-spinner" aria-hidden="true" />
              <span>{t("settings.voiceTranscribing")}</span>
            </>
          )}
          {state.phase === "error" && (
            <span className="voice-error">{state.error}</span>
          )}
        </div>
        <div className="voice-overlay-right">
          {state.phase === "listening" && (
            <VolumeBar level={state.volumeLevel} />
          )}
          {(state.phase === "listening" || state.phase === "starting") && (
            <button
              type="button"
              className="voice-cancel-btn"
              onClick={onCancel}
            >
              {t("settings.voiceCancel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function VolumeBar({ level }: { level: number }) {
  const width = Math.min(100, Math.max(0, level * 100));
  return (
    <div className="voice-volume-bar" aria-hidden="true">
      <div className="voice-volume-fill" style={{ width: `${width}%` }} />
    </div>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}
