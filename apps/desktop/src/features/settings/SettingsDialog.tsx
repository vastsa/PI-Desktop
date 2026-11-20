import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconClose } from "../../components/icons";
import { OverlayBackdrop, portalOverlay, TooltipButton } from "../../components/ui";
import { ModalLayer } from "../../lib/portal-visibility";
import { useModalDialog } from "../../lib/use-modal-dialog";
import { SettingsPage } from "./SettingsPage";

/**
 * Settings as a modal dialog over the current page. The rail, search and
 * destinations are the same `SettingsPage`; only the frame is modal.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalDialog(dialogRef, { onClose });

  return portalOverlay(
    <ModalLayer>
      <OverlayBackdrop
        className="overlay settings-dialog-overlay"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={dialogRef}
          className="dialog settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.title")}
          data-surface="settings-dialog"
        >
          <SettingsPage />
          <TooltipButton
            type="button"
            className="icon-btn settings-dialog-close"
            data-nav="close-settings"
            tooltip={t("settings.close")}
            ariaLabel={t("settings.close")}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
      </OverlayBackdrop>
    </ModalLayer>,
  );
}
