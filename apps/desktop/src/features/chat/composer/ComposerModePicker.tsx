import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { Mode } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import { useModesStore } from "../../modes/modes-store";
import {
  modeDisplayLabel,
  userModePickerEntries,
  type UserModePickerEntry,
} from "../../modes/mode-picker-model";
import { ModeIcon } from "./ComposerModeIcon";
import { MODE_CYCLE } from "./model";
import "../../../styles/modes.css";

/**
 * Operating mode as a compact chip that opens one menu.
 *
 * The chip only ever names the committed mode, so the toolbar keeps the width
 * of a single label; the other modes are one menu away instead of one
 * cycle-click away. Builtins come first with their localized labels, then the
 * user's modes from the catalog (ADR mode-definitions).
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
  const catalog = useModesStore((state) => state.catalog);
  const userEntries = userModePickerEntries(catalog);
  const label = modeDisplayLabel(t, mode, catalog);
  const staged = catalog?.modes.find((entry) => entry.id === mode && !entry.reserved)?.staged;
  // Only the builtin Plan negotiates a proposal, so only Plan has planning copy.
  const planningCopy = t("plan.planning");
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
          tooltip={planningLive ? planningCopy : t("settings.mode")}
          ariaLabel={
            planningLive
              ? `${t("settings.mode")}: ${label}. ${planningCopy}`
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
            <ModeIcon mode={mode} staged={staged} />
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
          <span className="flex-1 text-left">{modeDisplayLabel(t, candidate, catalog)}</span>
          {mode === candidate ? <IconCheck size={13} /> : null}
        </button>
      ))}
      <ComposerUserModeItems
        t={t}
        mode={mode}
        entries={userEntries}
        controlsBlocked={controlsBlocked}
        onPick={async (candidate) => {
          setOpen(false);
          await onSelect(candidate);
        }}
      />
    </AnchoredMenu>
  );
}

/**
 * The user's modes under the builtins. Labels are shown as written; the
 * description is the tooltip. An unavailable mode stays visible but cannot be
 * chosen, and its first diagnostic says why.
 */
export function ComposerUserModeItems({
  t,
  mode,
  entries,
  controlsBlocked,
  onPick,
}: {
  t: TFunction;
  mode: Mode;
  entries: readonly UserModePickerEntry[];
  controlsBlocked: boolean;
  onPick: (mode: Mode) => void | Promise<void>;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <div className="composer-menu-separator" role="separator" />
      <div className="composer-mode-menu-group" aria-hidden="true">
        {t("modes.picker.custom")}
      </div>
      {entries.map((entry) => {
        const unavailable = !entry.available;
        const title = unavailable
          ? entry.reason
            ? `${t("modes.picker.unavailable")}: ${entry.reason}`
            : t("modes.picker.unavailable")
          : entry.description || undefined;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitemradio"
            aria-checked={mode === entry.id}
            // Not `disabled`: a disabled button shows no tooltip, and the
            // tooltip is where the diagnostic is read.
            aria-disabled={unavailable || undefined}
            disabled={controlsBlocked}
            title={title}
            data-mode-id={entry.id}
            className={`composer-plus-item ${mode === entry.id ? "active" : ""}`}
            onClick={() => {
              if (unavailable) return;
              void onPick(entry.id);
            }}
          >
            <span className="composer-mode-item-label flex-1 text-left">{entry.label}</span>
            {unavailable ? (
              <span className="composer-mode-item-note">{t("modes.picker.unavailable")}</span>
            ) : mode === entry.id ? (
              <IconCheck size={13} />
            ) : null}
          </button>
        );
      })}
    </>
  );
}
