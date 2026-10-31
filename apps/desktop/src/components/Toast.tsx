import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
} from "react";
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
import { Button, TooltipButton } from "./ui";
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
  const sessionId = item.sessionId;
  const [closing, setClosing] = useState(false);
  // Hover or keyboard focus pauses the auto-dismiss timer.
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
    if (item.duration === 0 || closing || timerRef.current !== null) return;
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
  const content = <>
    <span className="toast-icon" aria-hidden>
      <Icon size={16} />
    </span>
    <span className="toast-message selectable">{item.message}</span>
  </>;
  return (
    <div
      className={`toast ${item.variant}${closing ? " closing" : ""}`}
      role={item.variant === "error" || item.variant === "warning" ? "alert" : "status"}
      onMouseEnter={pauseTimer}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) resumeTimer();
      }}
      onFocusCapture={pauseTimer}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) {
          resumeTimer();
        }
      }}
      onAnimationEnd={onAnimationEnd}
    >
      {sessionId ? (
        <Button
          type="button"
          variant="ghost"
          className="toast-action"
          onClick={(event) => {
            // Dragging to copy the question is not a navigation gesture.
            const selection = window.getSelection();
            if (!selection?.isCollapsed && selection?.containsNode(event.currentTarget, true)) return;
            void useAppStore.getState().selectSession(sessionId).then(() => {
              dismissToast(item.id);
            }).catch((error) => {
              useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), {
                variant: "error",
              });
            });
          }}
        >
          {content}
        </Button>
      ) : content}
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
type ToastViewportBounds = {
  center: number;
  width: number;
};

function useToastViewportBounds(
  anchorElement?: HTMLElement | null,
): ToastViewportBounds | null {
  const [bounds, setBounds] = useState<ToastViewportBounds | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorElement;
    if (!anchor) {
      setBounds(null);
      return;
    }
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const next = { center: rect.left + rect.width / 2, width: rect.width };
      setBounds((current) =>
        current?.center === next.center && current.width === next.width ? current : next,
      );
    };
    const observer = new ResizeObserver(update);
    const layoutRoot = anchor.parentElement;
    const observeLayout = () => {
      observer.disconnect();
      observer.observe(anchor);
      for (const sibling of layoutRoot?.children ?? []) {
        if (sibling !== anchor) observer.observe(sibling);
      }
      update();
    };
    const mutationObserver = new MutationObserver(observeLayout);
    if (layoutRoot) mutationObserver.observe(layoutRoot, { childList: true });
    observeLayout();
    window.addEventListener("resize", update);
    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchorElement]);

  return bounds;
}

type ToastHostProps = {
  /** Optional viewport region whose top center owns the toast stack. */
  anchorElement?: HTMLElement | null;
};

/** Global toast stack — mount once per shell, above dialogs (z-toast). */
export function ToastHost({ anchorElement }: ToastHostProps = {}) {
  const toasts = useAppStore((s) => s.toasts);
  const visibleToastIds = useRef<Set<number>>(new Set());
  const host = useToastHost();
  const bounds = useToastViewportBounds(anchorElement);
  const viewportStyle = bounds
    ? ({
        "--toast-viewport-center": `${bounds.center}px`,
        "--toast-viewport-width": `${Math.max(0, bounds.width - 32)}px`,
      } as CSSProperties)
    : undefined;

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
    <div className="toast-viewport" aria-live="polite" style={viewportStyle}>
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>,
    host,
  );
}
