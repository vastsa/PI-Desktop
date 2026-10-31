import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@pi-desktop/shared";

export type SessionHoverCardData = {
  session: SessionSummary;
  target: HTMLElement;
  temporary: boolean;
  space: string;
  branch?: string;
};

export function useSessionHoverCard() {
  const [card, setCard] = useState<SessionHoverCardData | null>(null);
  const requestRef = useRef<SessionHoverCardData | null>(null);
  const dismissGuardRef = useRef<(() => boolean) | null>(null);
  const registerDismissGuard = useCallback((guard: () => boolean) => {
    dismissGuardRef.current = guard;
    return () => {
      if (dismissGuardRef.current === guard) dismissGuardRef.current = null;
    };
  }, []);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelPending = useCallback(() => {
    requestRef.current = null;
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const cancelDismiss = useCallback(() => {
    clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = undefined;
  }, []);

  const hide = useCallback(() => {
    cancelDismiss();
    cancelPending();
    setCard(null);
  }, [cancelDismiss, cancelPending]);

  const scheduleHide = useCallback(() => {
    cancelDismiss();
    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = undefined;
      if (!dismissGuardRef.current?.()) hide();
    }, 160);
  }, [cancelDismiss, hide]);

  const show = useCallback((request: SessionHoverCardData) => {
    if (requestRef.current?.target === request.target) return;
    cancelDismiss();
    cancelPending();
    setCard(null);
    requestRef.current = request;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      if (requestRef.current !== request || !request.target.isConnected || document.hidden) return;
      setCard(request);
    }, 500);
  }, [cancelDismiss, cancelPending]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    const onVisibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("pointerdown", hide);
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelDismiss();
      cancelPending();
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("pointerdown", hide);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancelDismiss, cancelPending, hide]);

  useEffect(() => {
    if (card && !card.target.isConnected) hide();
  });

  return { card, show, hide, scheduleHide, keepVisible: cancelDismiss, registerDismissGuard };
}
