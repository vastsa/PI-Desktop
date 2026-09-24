import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { IconClose } from "../../components/icons";
import { portalOverlay } from "../../components/ui";
// Renderer-sized copies of the two Mid-Autumn textures (same import style as
// components/BrandLogo.tsx).
import moonImageUrl from "../../assets/mid-autumn-moon.webp";
import cakeImageUrl from "../../assets/mid-autumn-cake.webp";
import { createMidAutumnEggScene, type MidAutumnEggScene } from "./scene";
import "./mid-autumn-egg.css";

/**
 * Full-screen Mid-Autumn easter egg.
 *
 * The overlay renders one canvas; the scene owns everything that is drawn
 * inside it, including the decoration layer (veil, caption, sparks) it creates
 * next to the canvas. Closing (button or Escape) destroys the scene, so the
 * animation loop and its timers never outlive the overlay.
 */
export function MidAutumnEggOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene: MidAutumnEggScene = createMidAutumnEggScene({
      canvas,
      moonImageUrl,
      cakeImageUrl,
      // A failed texture is not fatal, but it must not vanish without a trace.
      onError: (error) => console.error("Mid-Autumn easter egg scene error", error),
    });
    scene.start();
    return () => scene.destroy();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return portalOverlay(
    <div
      ref={dialogRef}
      className="overlay mid-autumn-egg-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.midAutumnEgg")}
    >
      <canvas ref={canvasRef} className="mid-autumn-egg-canvas" />
      <button
        ref={closeRef}
        type="button"
        className="mid-autumn-egg-close"
        onClick={onClose}
        aria-label={t("settings.closeEasterEgg")}
      >
        <IconClose size={16} />
        <span>{t("settings.closeEasterEgg")}</span>
      </button>
    </div>,
  );
}
