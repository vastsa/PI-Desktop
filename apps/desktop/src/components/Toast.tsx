import { useCallback, useEffect, useRef, useState, type AnimationEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore, type ToastItem, type ToastVariant } from "../stores/app-store";
import {
  IconCircleAlert,
  IconCircleCheck,
  IconClose,
  IconInfo,
  IconTriangleAlert,
} from "./icons";
import { TooltipButton } from "./ui";
import {
  playNotificationChime,
  shouldPlayToastSound,
} from "../lib/notification-sound";

const VARIANT_ICON: Record<ToastVariant, typeof IconInfo> = {
  info: IconInfo,
  success: IconCircleCheck,
  warning: IconTriangleAlert,
  error: IconCircleAlert,
};

function ToastCard({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const dismissToast = useAppStore((s) => s.dismissToast);
  const [closing, setClosing] = useState(false);
  // Hover pauses the auto-dismiss timer; remaining time survives re-hovers.
  const remainingRef = useRef(item.duration);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const beginClose = useCallback(() => setClosing(true), []);

  const pauseTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current -= Date.now() - startedAtRef.current;
  }, []);

  const resumeTimer = useCallback(() => {
    if (item.duration === 0 || closing) return;
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(beginClose, Math.max(remainingRef.current, 0));
  }, [item.duration, closing, beginClose]);

  useEffect(() => {
    resumeTimer();
    return pauseTimer;
  }, [resumeTimer, pauseTimer]);

  const onAnimationEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.animationName === "toast-out") dismissToast(item.id);
  };

  const Icon = VARIANT_ICON[item.variant];
  return (
    <div
      className={`toast ${item.variant}${closing ? " closing" : ""}`}
      role={item.variant === "error" || item.variant === "warning" ? "alert" : "status"}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      onAnimationEnd={onAnimationEnd}
    >
      <span className="toast-icon" aria-hidden>
        <Icon size={16} />
      </span>
      <span className="toast-message selectable">{item.message}</span>
      <TooltipButton
        type="button"
        className="toast-dismiss"
        tooltip={t("toast.dismiss")}
        ariaLabel={t("toast.dismiss")}
        onClick={beginClose}
      >
        <IconClose size={13} />
      </TooltipButton>
    </div>
  );
}

/**
 * The toast stack lives on the body, not inside the shell.
 *
 * `.app-shell` isolates its own layers, and every dialog is portaled to the
 * viewport overlay host at `z-dialog` (40). A stack rendered inside the shell
 * paints inside that isolated context, so the dialog scrim covers it — the one
 * surface a toast has to be seen above. A body-level host puts it back in the
 * root stacking context, where its own `z-toast` (50) still outranks a dialog.
 */
function useToastHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const element = document.createElement("div");
    document.body.append(element);
    setHost(element);
    return () => element.remove();
  }, []);
  return host;
}

/** Global toast stack — mount once per shell, above dialogs (z-toast). */
export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  const visibleToastIds = useRef<Set<number>>(new Set());
  const host = useToastHost();

  useEffect(() => {
    const nextVisibleIds = new Set<number>();
    let shouldPlay = false;
    for (const toast of toasts) {
      nextVisibleIds.add(toast.id);
      if (shouldPlayToastSound(toast, visibleToastIds.current)) shouldPlay = true;
    }
    visibleToastIds.current = nextVisibleIds;
    if (shouldPlay) playNotificationChime();
  }, [toasts]);

  // The host is attached in an effect, so the first render deliberately paints
  // nothing rather than mounting the stack inside the shell it must outrank.
  if (!host) return null;
  return createPortal(
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>,
    host,
  );
}
