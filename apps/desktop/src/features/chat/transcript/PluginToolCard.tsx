/**
 * The `toolCard` slot host (`docs/plugin-plan/ui/tool-card/`).
 *
 * One plugin card replaces the host default card entirely for a claimed
 * tool call; the plugin draws the whole card and failure stays data. The
 * host owns the push cadence: running updates merge onto a 500ms beat so a
 * chatty stream cannot re-render the card per token, while a status
 * transition and the final result push immediately. A card that throws
 * collapses alone and the host default card takes its place, so a broken
 * plugin never hides a tool call from the transcript.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import type { PluginToolCardSlotProps } from "@pi-desktop/plugin-sdk";
import {
  SlotBoundary,
  slotElement,
  useSlotSessionId,
} from "../../../plugins/renderer-slots/use-slots";
import type { SlotEntry } from "../../../plugins/renderer-slots/registry";
import {
  TOOL_CARD_RUNNING_INTERVAL_MS,
  shouldEmitToolCard,
  toolCardSlotProps,
  toolCardStatusOf,
} from "./tool-card-props";

export function PluginToolCard({
  entry,
  message,
  fallback,
}: {
  entry: SlotEntry;
  message: UiMessage;
  /** The host default card, shown instead when the plugin card throws. */
  fallback: ReactNode;
}) {
  const sessionId = useSlotSessionId();
  const toolName = entry.toolName ?? "";
  // The committed projection only advances on the cadence, never per tick.
  const [committed, setCommitted] = useState<PluginToolCardSlotProps>(() =>
    toolCardSlotProps(message, toolName, sessionId),
  );
  const lastEmitRef = useRef({
    at: Date.now(),
    status: committed.toolStatus,
    message,
    sessionId,
  });

  useLayoutEffect(() => {
    const last = lastEmitRef.current;
    if (last.message === message && last.sessionId === sessionId) return;
    const status = toolCardStatusOf(message);
    const emit = () => {
      lastEmitRef.current = { at: Date.now(), status, message, sessionId };
      setCommitted(toolCardSlotProps(message, toolName, sessionId));
    };
    if (shouldEmitToolCard(last.at, last.status, status, Date.now())) {
      emit();
      return;
    }
    // Still running before the beat: commit with the latest data at the
    // next boundary, so the merged push never drops the newest snapshot.
    const timer = window.setTimeout(
      emit,
      Math.max(0, TOOL_CARD_RUNNING_INTERVAL_MS - (Date.now() - last.at)),
    );
    return () => window.clearTimeout(timer);
  }, [message, sessionId, toolName]);

  return (
    <SlotBoundary entry={entry} fallback={fallback}>
      {slotElement(entry, committed)}
    </SlotBoundary>
  );
}
