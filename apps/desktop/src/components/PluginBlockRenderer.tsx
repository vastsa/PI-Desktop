/**
 * The `blockRenderer` slot host (`docs/plugin-plan/ui/block-renderer/`).
 *
 * A claimed fence hands `{ language, source }` to the plugin once (props-once)
 * and the plugin owns the whole block — head, copy button, error display.
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
  sourcePosition,
  fallback,
}: {
  entry: SlotEntry;
  language: string;
  source: string;
  /** Where the fence sits in the message source. */
  sourcePosition: SourcePositionProps;
  /** The host default block, shown when the plugin fails the contract. */
  fallback: ReactNode;
}) {
  // props-once: the first mount's projection is the only one there is.
  const onceRef = useRef<PluginBlockRendererSlotProps>({ language, source });
  const clampRef = useRef<HTMLDivElement>(null);
  const [overflowed, setOverflowed] = useState(false);

  useLayoutEffect(() => {
    const el = clampRef.current;
    if (el && blockRendererOverflow(el.scrollHeight)) {
      setOverflowed(true);
    }
  }, []);

  if (overflowed) return fallback;
  return (
    <SlotErrorBoundary entry={entry} fallback={fallback}>
      <div
        ref={clampRef}
        className="pi-plugin-block-renderer"
        style={{ maxHeight: BLOCK_RENDERER_MAX_HEIGHT_PX }}
        {...sourcePosition}
      >
        <SlotMount entry={entry}>{slotElement(entry, onceRef.current)}</SlotMount>
      </div>
    </SlotErrorBoundary>
  );
}
