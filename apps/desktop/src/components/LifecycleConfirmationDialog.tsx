import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LifecycleDialogChoice,
  LifecycleDialogRequest,
} from "@pi-desktop/shared";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { api } from "../lib/api";
import { Button, OverlayBackdrop, portalOverlay } from "./ui";

type DialogSurfaceProps = {
  request: LifecycleDialogRequest;
  onRespond: (choice: LifecycleDialogChoice) => void;
};

function DialogSurface({ request, onRespond }: DialogSurfaceProps) {
  const { t } = useTranslation();
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const isCloseBehavior = request.kind === "close-behavior";
  const title = isCloseBehavior ? t("tray.askTitle") : t("tray.confirmQuitTitle");
  const description = isCloseBehavior ? t("tray.askBody") : t("tray.confirmQuitBody");
  useBlockingOverlay();

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => cancelButton.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onRespond("cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialog.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = Array.from(focusable).indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [request.requestId, onRespond]);

  return portalOverlay(
    <OverlayBackdrop
      className="overlay lifecycle-confirmation-overlay"
      role="presentation"
      onClick={() => onRespond("cancel")}
    >
      <div
        ref={dialog}
        className="dialog lifecycle-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifecycle-confirmation-title"
        aria-describedby="lifecycle-confirmation-description"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="lifecycle-confirmation-heading">
          <h2 id="lifecycle-confirmation-title">{title}</h2>
          <p id="lifecycle-confirmation-description">{description}</p>
        </div>
        <div className="lifecycle-confirmation-actions">
          <Button
            ref={cancelButton}
            type="button"
            variant="ghost"
            onClick={() => onRespond("cancel")}
          >
            {t("common.cancel")}
          </Button>
          {isCloseBehavior ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => onRespond("tray")}
              >
                {t("tray.closeToTray")}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => onRespond("quit")}
              >
                {t("tray.quit")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={() => onRespond("confirm")}
            >
              {t("tray.confirmQuit")}
            </Button>
          )}
        </div>
      </div>
    </OverlayBackdrop>,
  );
}

export function LifecycleConfirmationDialog() {
  const [request, setRequest] = useState<LifecycleDialogRequest | null>(null);
  const activeRequest = useRef<LifecycleDialogRequest | null>(null);

  const respond = useCallback((choice: LifecycleDialogChoice) => {
    const current = activeRequest.current;
    if (!current) return;
    activeRequest.current = null;
    setRequest(null);
    void api.respondLifecycleDialog(current.requestId, choice).catch((error: unknown) => {
      console.error("Failed to resolve lifecycle dialog", error);
    });
  }, []);

  useEffect(() => {
    const unsubscribeRequest = api.onLifecycleDialogRequest((next) => {
      activeRequest.current = next;
      setRequest(next);
    });
    const unsubscribeDismiss = api.onLifecycleDialogDismiss((requestId) => {
      if (activeRequest.current?.requestId !== requestId) return;
      activeRequest.current = null;
      setRequest(null);
    });
    void api.markLifecycleDialogRendererReady().catch((error: unknown) => {
      console.error("Failed to register lifecycle dialog renderer", error);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeDismiss();
      activeRequest.current = null;
    };
  }, []);

  return request ? <DialogSurface request={request} onRespond={respond} /> : null;
}
