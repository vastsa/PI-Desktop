/**
 * The `entryExtra` slot mount (`docs/plugin-plan/ui/entry-extra/`).
 *
 * Additive blocks under a finished assistant reply, stacked in registration
 * order. The host owns the height: a collapsed block clamps at 320px, fades
 * out at the edge and offers the host expand toggle; an expanded one scrolls
 * inside 600px. The toggle is host chrome outside the plugin's mount, so the
 * plugin's scoped styles never reach it. A block whose component throws
 * disappears, toggle included; the other blocks stay.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginEntryExtraSlotProps } from "@pi-desktop/plugin-sdk";
import {
  SlotErrorBoundary,
  SlotMount,
  slotElement,
  useSlotEntries,
  useSlotSessionId,
} from "../../../plugins/renderer-slots/use-slots";
import type { SlotEntry } from "../../../plugins/renderer-slots/registry";
import {
  ENTRY_EXTRA_COLLAPSED_MAX_HEIGHT,
  ENTRY_EXTRA_EXPANDED_MAX_HEIGHT,
  entryExtraSlotProps,
} from "./entry-extra-props";

type SlotReply = PluginEntryExtraSlotProps["message"];

/** One registration's clamped viewport plus the host expand toggle. */
function EntryExtraBlock({
  entry,
  message,
  sessionId,
}: {
  entry: SlotEntry;
  message: SlotReply;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // The toggle exists only while the content is taller than the viewport;
  // observing both keeps that true when a block loads its data late.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(content.scrollHeight > viewport.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="pi-entry-extra-block">
      <div
        ref={viewportRef}
        className="pi-entry-extra-viewport"
        data-expanded={expanded ? "true" : undefined}
        data-clipped={!expanded && overflows ? "true" : undefined}
        style={{
          maxHeight: expanded ? ENTRY_EXTRA_EXPANDED_MAX_HEIGHT : ENTRY_EXTRA_COLLAPSED_MAX_HEIGHT,
        }}
      >
        <div ref={contentRef}>
          <SlotMount entry={entry}>
            {slotElement(entry, entryExtraSlotProps(message, sessionId))}
          </SlotMount>
        </div>
      </div>
      {expanded || overflows ? (
        <button
          type="button"
          className="pi-entry-extra-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("chat.entryExtraCollapse") : t("chat.entryExtraExpand")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The slot region of one finished assistant reply: a block per registration,
 * in registration order, or nothing when no plugin registered the slot.
 */
export function EntryExtraStack({ message }: { message: SlotReply }) {
  const entries = useSlotEntries("entryExtra");
  const sessionId = useSlotSessionId();
  if (entries.length === 0) return null;
  return (
    <div className="pi-entry-extra-stack">
      {entries.map((entry) => (
        <SlotErrorBoundary key={entry.id} entry={entry}>
          <EntryExtraBlock entry={entry} message={message} sessionId={sessionId} />
        </SlotErrorBoundary>
      ))}
    </div>
  );
}
