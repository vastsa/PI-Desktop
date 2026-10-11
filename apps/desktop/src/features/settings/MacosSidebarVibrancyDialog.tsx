import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton } from "../../components/ui";
import { IconClose, IconInfo } from "../../components/icons";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";

/**
 * Confirm before a macOS sidebar-vibrancy change. The window backing is fixed
 * at construction, so confirming restarts the app rather than rebuilding the
 * live window.
 */
export function MacosSidebarVibrancyDialog({
  enabling,
  onCancel,
  onConfirm,
}: {
  enabling: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const busyRef = useRef(false);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (!focusable?.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (active === dialogRef.current || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSaveFailed(false);
    try {
      await onConfirm();
      onCancelRef.current();
    } catch {
      busyRef.current = false;
      setBusy(false);
      setSaveFailed(true);
      dialogRef.current?.focus();
    }
  };

  const dialog = (
    <div
      className="overlay settings-confirm-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onCancelRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog settings-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="macos-sidebar-vibrancy-title"
        aria-describedby={
          saveFailed
            ? "macos-sidebar-vibrancy-description macos-sidebar-vibrancy-error"
            : "macos-sidebar-vibrancy-description"
        }
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-confirm-dialog-head">
          <div>
            <h2 id="macos-sidebar-vibrancy-title" className="settings-confirm-dialog-title">
              <IconInfo size={16} aria-hidden />
              {t("settings.macosSidebarVibrancy")}
            </h2>
            <p id="macos-sidebar-vibrancy-description" className="settings-confirm-dialog-description">
              {t(enabling
                ? "settings.macosSidebarVibrancyEnableConfirm"
                : "settings.macosSidebarVibrancyDisableConfirm")}
            </p>
          </div>
          <TooltipButton
            type="button"
            className="settings-confirm-dialog-close"
            tooltip={t("common.cancel")}
            ariaLabel={t("common.cancel")}
            disabled={busy}
            onClick={() => onCancelRef.current()}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        {saveFailed && (
          <p id="macos-sidebar-vibrancy-error" className="settings-confirm-dialog-error" role="alert" aria-live="assertive">
            {t("settings.macosSidebarVibrancySaveFailed")}
          </p>
        )}
        <div className="settings-confirm-dialog-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onCancelRef.current()}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void confirm()}>
            {t("settings.macosSidebarVibrancyRestart")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
