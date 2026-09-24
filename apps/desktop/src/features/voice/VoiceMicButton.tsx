/**
 * Microphone button for the Composer toolbar.
 */

import type { TFunction } from "i18next";
import { TooltipButton } from "../../components/ui";
import type { VoicePhase } from "./useVoiceInput";

interface VoiceMicButtonProps {
  t: TFunction;
  phase: VoicePhase;
  disabled: boolean;
  onToggle: () => void;
  onCancel: () => void;
}

export function VoiceMicButton({
  t,
  phase,
  disabled,
  onToggle,
  onCancel,
}: VoiceMicButtonProps) {
  const isActive =
    phase === "starting" ||
    phase === "listening" ||
    phase === "transcribing";

  const tooltip = isActive
    ? t("settings.voiceCancel")
    : t("settings.voiceRecording").replace("…", "");

  return (
    <TooltipButton
      type="button"
      className={`icon-btn${isActive ? " voice-active" : ""}`}
      tooltip={tooltip}
      ariaLabel={tooltip}
      disabled={disabled && !isActive}
      onClick={isActive ? onCancel : onToggle}
    >
      <MicIcon active={isActive} phase={phase} />
    </TooltipButton>
  );
}

function MicIcon({ active, phase }: { active: boolean; phase: VoicePhase }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={active ? "voice-mic-active" : undefined}
    >
      {/* Microphone body */}
      <rect
        x="5.5"
        y="1.5"
        width="5"
        height="8"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.2"
        fill={active ? "currentColor" : "none"}
      />
      {/* Stand arc */}
      <path
        d="M3.5 7.5a4.5 4.5 0 0 0 9 0"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      {/* Stand line */}
      <line
        x1="8"
        y1="12"
        x2="8"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Base */}
      <line
        x1="6"
        y1="14"
        x2="10"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Recording indicator */}
      {phase === "listening" && (
        <circle cx="13" cy="3" r="2.5" fill="var(--color-danger, #ef4444)">
          <animate
            attributeName="opacity"
            values="1;0.3;1"
            dur="1.2s"
            repeatCount="indefinite"
          />
        </circle>
      )}
    </svg>
  );
}
