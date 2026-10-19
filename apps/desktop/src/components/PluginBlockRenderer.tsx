/**
 * The `blockRenderer` slot host (`docs/plugin-plan/ui/block-renderer/`).
 *
 * A default claimed fence hands `{ language, source }` to the plugin once (props-once)
 * and the plugin owns the whole block — head, copy button, error display.
 * Opt-in streaming registrations also receive live source and host identity.
 * The host keeps exactly one guarantee: content taller than 4000px counts as
 * a render failure and falls back to the host code block, and so does a
 * component that throws (via the boundary's fallback) — the source code must
 * always stay visible to the user.
 *
 * The clamp is host chrome, so it wraps the plugin's mount rather than
 * sitting inside it, and it carries the fence's source anchor so transcript
 * search lands on the block as it would on the host code block.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PluginBlockRendererSlotProps } from "@pi-desktop/plugin-sdk";
import {
  SlotErrorBoundary,
  SlotMount,
  slotElement,
  useSlotSessionId,
} from "../plugins/renderer-slots/use-slots";
import type { SlotEntry } from "../plugins/renderer-slots/registry";
import type { SourcePositionProps } from "../lib/markdown-source";
import {
  BLOCK_RENDERER_MAX_HEIGHT_PX,
  blockRendererOverflow,
} from "../lib/block-renderer";

export function PluginBlockRenderer({
  entry,
  language,
  source,
  messageId,
  fenceId,
  closed,
  streaming,
  sourcePosition,
  fallback,
}: {
  entry: SlotEntry;
  language: string;
  source: string;
  messageId: string;
  fenceId: string;
  closed: boolean;
  streaming: boolean;
  /** Where the fence sits in the message source. */
  sourcePosition: SourcePositionProps;
  /** The host default block, shown when the plugin fails the contract. */
  fallback: ReactNode;
}) {
  // Default registrations retain their first projection across later renders.
  const onceRef = useRef<PluginBlockRendererSlotProps>({ language, source });
  const sessionId = useSlotSessionId();
  const props = entry.streaming
    ? { language, source, sessionId, messageId, fenceId, closed, streaming }
    : onceRef.current;
  const clampRef = useRef<HTMLDivElement>(null);
  const [overflowed, setOverflowed] = useState(false);

  useLayoutEffect(() => {
    const el = clampRef.current;
    if (!el) return;
    const measure = () => {
      if (blockRendererOverflow(el.scrollHeight)) setOverflowed(true);
    };
    measure();
    if (!entry.streaming || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The clamp can stay at 4000px while its contents continue to grow.
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [entry.streaming, source, overflowed]);

  if (overflowed) return fallback;
  return (
    <SlotErrorBoundary entry={entry} fallback={fallback}>
      <div
        ref={clampRef}
        className="pi-plugin-block-renderer"
        style={{ maxHeight: BLOCK_RENDERER_MAX_HEIGHT_PX }}
        {...sourcePosition}
      >
        <SlotMount entry={entry}>{slotElement(entry, props)}</SlotMount>
      </div>
    </SlotErrorBoundary>
  );
}
