import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../lib/use-modal-dialog";
import { OverlayBackdrop, TooltipButton, portalOverlay } from "../../components/ui";
import { IconClose } from "../../components/icons";

export function LanDialog({
  id,
  title,
  description,
  icon,
  onClose,
  busy = false,
  error,
  children,
  footer,
}: {
  id: string;
  title: string;
  description?: string;
  icon: ReactNode;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation("lan");
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = () => { if (!busy) onClose(); };
  useModalDialog(dialogRef, { onClose: close });

  return portalOverlay(
    <OverlayBackdrop className="overlay lan-dialog-overlay" role="presentation" onClick={close}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="dialog lan-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={busy || undefined}
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
      >
        <header className="lan-dialog-head">
          <span className="lan-dialog-icon" aria-hidden="true">{icon}</span>
          <div className="lan-dialog-heading">
            <h2 id={`${id}-title`} className="lan-dialog-title">{title}</h2>
            {description ? <p id={`${id}-description`} className="lan-dialog-description">{description}</p> : null}
          </div>
          <TooltipButton
            type="button"
            className="icon-btn lan-dialog-close"
            tooltip={t("close")}
            ariaLabel={t("close")}
            aria-disabled={busy || undefined}
            onClick={close}
          >
            <IconClose size={16} />
          </TooltipButton>
        </header>
        <div className="lan-dialog-body">{children}</div>
        {error ? <p className="lan-error lan-dialog-error" role="alert">{error}</p> : null}
        {footer ? <footer className="lan-dialog-footer">{footer}</footer> : null}
      </div>
    </OverlayBackdrop>,
  );
}
