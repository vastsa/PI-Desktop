import { useCallback, useEffect, useRef, useState, type AnimationEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type ToastItem, type ToastVariant } from "../stores/app-store";
import {
  IconCircleAlert,
  IconCircleCheck,
  IconClose,
  IconInfo,
  IconTriangleAlert,
} from "./icons";

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
      <span className="toast-message">{item.message}</span>
      <button
        type="button"
        className="toast-dismiss"
        aria-label={t("toast.dismiss")}
        onClick={beginClose}
      >
        <IconClose size={13} />
      </button>
    </div>
  );
}

/** Global toast stack — mount once per shell, above dialogs (z-toast). */
export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>
  );
}
