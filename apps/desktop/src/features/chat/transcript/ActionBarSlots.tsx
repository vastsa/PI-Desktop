/**
 * The action-bar sides of `userAction` / `assistantAction`
 * (`docs/plugin-plan/ui/user-action/`, `docs/plugin-plan/ui/assistant-action/`).
 *
 * A bar renders its left side, its host keys, then its right side; a plugin
 * can add around the host keys but never change, hide or fold them. Each side
 * shows up to three items and folds the rest into its own "⋯" menu
 * (`splitActionSide`); the registry re-renders the sides when a plugin loads
 * or unloads, so they reflow at once. Every item sits in its own boundary: a
 * throwing item disappears alone.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginSlotMessage, PluginSlotPosition } from "@pi-desktop/plugin-sdk";
import {
  SlotBoundary,
  slotElement,
  useSlotEntries,
  useSlotSessionId,
} from "../../../plugins/renderer-slots/use-slots";
import type { SlotEntry } from "../../../plugins/renderer-slots/registry";
import { actionSlotProps, splitActionSide } from "./action-slot-props";

type ActionSlot = "userAction" | "assistantAction";

type ItemContext = {
  message: PluginSlotMessage;
  sessionId: string;
  side: PluginSlotPosition;
};

function ActionSlotItem({ entry, context }: { entry: SlotEntry; context: ItemContext }) {
  return (
    <SlotBoundary entry={entry}>
      {slotElement(entry, actionSlotProps(context.message, context.sessionId, context.side))}
    </SlotBoundary>
  );
}

/** One side's "⋯" menu holding the items past the visible three. */
function ActionOverflowMenu({ entries, context }: { entries: SlotEntry[]; context: ItemContext }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // A pointer press anywhere else closes the menu, and so does Escape, which
  // hands the focus back to the ⋯ key.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="pi-action-overflow" data-side={context.side}>
      <button
        ref={buttonRef}
        type="button"
        className="copy-btn icon pi-action-overflow-btn"
        aria-label={t("chat.actionSlotMore")}
        title={t("chat.actionSlotMore")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open ? (
        <div className="pi-action-overflow-panel" role="group" aria-label={t("chat.actionSlotMore")}>
          {entries.map((entry) => (
            <ActionSlotItem key={entry.id} entry={entry} context={context} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One plugin side of an action bar: its first three items and a ⋯ menu with
 * the rest. The menu sits at the outer end of the bar, before the items on
 * the left and after them on the right. Renders nothing without a message or
 * without registrations on this side.
 */
export function ActionSlotSide({
  slot,
  side,
  message,
}: {
  slot: ActionSlot;
  side: PluginSlotPosition;
  /** What the items act on; `undefined` keeps the side empty. */
  message: PluginSlotMessage | undefined;
}) {
  const entries = useSlotEntries(slot, side);
  const sessionId = useSlotSessionId();
  if (!message || entries.length === 0) return null;
  const context: ItemContext = { message, sessionId, side };
  const { visible, overflow } = splitActionSide(entries);
  const menu = overflow.length ? <ActionOverflowMenu entries={overflow} context={context} /> : null;
  const items = visible.map((entry) => (
    <ActionSlotItem key={entry.id} entry={entry} context={context} />
  ));
  return side === "left" ? (
    <>
      {menu}
      {items}
    </>
  ) : (
    <>
      {items}
      {menu}
    </>
  );
}
