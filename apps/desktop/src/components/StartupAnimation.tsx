import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { STARTUP_ANIMATION_URL } from "@pi-desktop/shared";
import type { StartupAnimationEndReason } from "../lib/startup-animation";
import { cx } from "./ui";

/**
 * Full-window boot surface playing the user's own animation (D679 / ADR 0338).
 *
 * The layer is opaque black for its whole life, including the reveal: the video
 * sits on it, and when the video is gone the same black is the mask the shell
 * fades in from. One element rather than two means there is no seam between the
 * last frame and the mask for a frame of shell to show through.
 *
 * The file is referenced only as the host-owned `pi-startup:` URL — the page
 * never learns a path — and the element is inert: no controls, no picture in
 * picture, not focusable, and muted, because an unmuted autoplay is both
 * blocked by Chromium and a poor thing to do to someone opening an app.
 */
export function StartupAnimation({
  playing,
  videoRef,
  revealing,
  holdingLong,
  onFirstFrame,
  onAnimationEnd,
}: {
  playing: boolean;
  videoRef?: RefObject<HTMLVideoElement | null>;
  revealing: boolean;
  holdingLong: boolean;
  onFirstFrame: () => void;
  onAnimationEnd: (reason: StartupAnimationEndReason) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className={cx("startup-animation", revealing && "is-revealing")}
      role="status"
      aria-live="polite"
      aria-busy={!revealing}
      data-testid="startup-animation"
    >
      {playing ? (
        <video
          ref={videoRef}
          className="startup-animation-video"
          src={STARTUP_ANIMATION_URL}
          autoPlay
          muted
          playsInline
          preload="auto"
          controls={false}
          disablePictureInPicture
          tabIndex={-1}
          aria-hidden
          onLoadedData={onFirstFrame}
          onPlaying={onFirstFrame}
          onEnded={() => onAnimationEnd("ended")}
          onError={() => onAnimationEnd("error")}
        />
      ) : null}
      {holdingLong ? (
        <div className="startup-animation-track" aria-hidden>
          <span className="startup-animation-bar" />
        </div>
      ) : null}
      <span className="sr-only">{t("app.starting")}</span>
    </div>
  );
}
