import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { IconMore } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { SessionActionItems } from "./SessionActionItems";
import { useSessionActions } from "./useSessionActions";
import { useSessionNavigation } from "./useSessionNavigation";

/** Keyed by session id by the topbar, so a navigation cannot retain an old menu. */
export function ConversationActions({ session }: { session: SessionSummary }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenus = useCallback((restore = true) => {
    setRestoreFocus(restore);
    setOpen(false);
  }, []);
  const navigation = useSessionNavigation();
  const actions = useSessionActions({
    ...navigation,
    closeMenus,
    afterPin: () => triggerRef.current?.focus(),
  });
  const dismiss = useCallback(() => closeMenus(), [closeMenus]);
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <>
      <AnchoredMenu
        open={open}
        onClose={dismiss}
        anchorRef={triggerRef}
        restoreFocus={restoreFocus}
        role="menu"
        align="end"
        menuClassName="sidebar-row-menu conversation-actions-menu"
        label={t("nav.sessionActions")}
        onMenuKeyDown={onMenuKeyDown}
        trigger={() => (
          <TooltipButton
            ref={triggerRef}
            type="button"
            className="ct-icon-btn"
            tooltip={t("nav.sessionActions")}
            ariaLabel={t("nav.sessionActions")}
            aria-haspopup="menu"
            aria-expanded={open}
            data-action="conversation-menu"
            onClick={() => {
              actions.resetDelete();
              setRestoreFocus(true);
              setOpen(!open);
            }}
          >
            <IconMore size={15} />
          </TooltipButton>
        )}
      >
        <SessionActionItems session={session} actions={actions} />
      </AnchoredMenu>
      {actions.renameDialog}
    </>
  );
}
