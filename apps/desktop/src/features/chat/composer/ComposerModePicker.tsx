import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { Mode } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import { ModeIcon } from "./ComposerModeIcon";
import { MODE_CYCLE, MODE_LABEL_KEYS } from "./model";

/**
 * Operating mode as a compact chip that opens one menu.
 *
 * The chip only ever names the committed mode, so the toolbar keeps the width
 * of a single label; the other two modes are one menu away instead of one
 * cycle-click away.
 */
export function ComposerModePicker({
  t,
  mode,
  planningLive,
  open,
  setOpen,
  controlsBlocked,
  onCloseOtherMenus,
  onSelect,
}: {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  onSelect: (mode: Mode) => void | Promise<void>;
}) {
  const label = t(MODE_LABEL_KEYS[mode]);
  return (
    <AnchoredMenu
      className="composer-mode"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-mode-menu"
      label={t("settings.mode")}
      role="menu"
      align="start"
      side="top"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn mode-chip composer-mode-chip ${open ? "active" : ""}`}
          data-mode={mode}
          data-planning={planningLive ? "true" : undefined}
          tooltip={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          ariaLabel={
            planningLive
              ? `${t("settings.mode")}: ${label}. ${t(`${mode}.planning`)}`
              : `${t("settings.mode")}: ${label}`
          }
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked}
          onClick={() => {
            onCloseOtherMenus();
            setOpen((current) => !current);
          }}
        >
          <span className="composer-mode-chip-face" key={mode}>
            <ModeIcon mode={mode} />
            <span className="composer-mode-chip-label text-sm">{label}</span>
          </span>
          <IconChevronDown
            size={12}
            aria-hidden="true"
            className="composer-mode-chip-caret"
          />
        </TooltipButton>
      )}
    >
      {MODE_CYCLE.map((candidate) => (
        <button
          key={candidate}
          type="button"
          role="menuitemradio"
          aria-checked={mode === candidate}
          disabled={controlsBlocked}
          className={`composer-plus-item ${mode === candidate ? "active" : ""}`}
          onClick={async () => {
            setOpen(false);
            await onSelect(candidate);
          }}
        >
          <span className="flex-1 text-left">{t(MODE_LABEL_KEYS[candidate])}</span>
          {mode === candidate ? <IconCheck size={13} /> : null}
        </button>
      ))}
    </AnchoredMenu>
  );
}
