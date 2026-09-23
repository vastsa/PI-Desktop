/**
 * The `toolCard` slot host (`docs/plugin-plan/ui/tool-card/`).
 *
 * One plugin card replaces the host default card entirely for a claimed
 * tool call; the plugin draws the whole card and failure stays data. The
 * host owns the push cadence: running updates merge onto a 500ms beat so a
 * chatty stream cannot re-render the card per token, while a status
 * transition and the final result push immediately. 出错隔离 lives in
 * `SlotBoundary` — a throwing card collapses only itself, and the host
 * default card is gone for this row, so the failure is a collapsed region,
 * not a missing tool call.
 */
import {
  createElement,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type { UiMessage } from "@pi-desktop/shared";
import type { PluginToolCardSlotProps } from "@pi-desktop/plugin-sdk";
import { SlotBoundary, useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import type { SlotEntry } from "../../../plugins/renderer-slots/registry";
import { dispatchFor } from "../../../plugins/renderer-host/dispatch";
import {
  TOOL_CARD_RUNNING_INTERVAL_MS,
  shouldEmitToolCard,
  toolCardPropsFor,
} from "./tool-card-props";

export function PluginToolCard({
  entry,
  message,
}: {
  entry: SlotEntry;
  message: UiMessage;
}) {
  const sessionId = useSlotSessionId();
  // The committed projection only advances on the cadence, never per tick.
  const [committed, setCommitted] = useState<PluginToolCardSlotProps>(() =>
    toolCardPropsFor(message, sessionId, dispatchFor(entry.pluginId)),
  );
  const lastEmitRef = useRef({ at: Date.now(), status: committed.toolStatus });

  useLayoutEffect(() => {
    const status = message.toolStatus === "running" || message.toolStatus === "error"
      ? message.toolStatus
      : "success";
    const emit = () => {
      lastEmitRef.current = { at: Date.now(), status };
      setCommitted(toolCardPropsFor(message, sessionId, dispatchFor(entry.pluginId)));
    };
    if (shouldEmitToolCard(lastEmitRef.current.at, lastEmitRef.current.status, status, Date.now())) {
      emit();
      return;
    }
    // Still running before the beat: commit with the latest data at the
    // next boundary, so the merged push never drops the newest snapshot.
    const remaining = Math.max(
      0,
      TOOL_CARD_RUNNING_INTERVAL_MS - (Date.now() - lastEmitRef.current.at),
    );
    const timer = window.setTimeout(emit, remaining);
    return () => window.clearTimeout(timer);
  }, [message, sessionId, entry]);

  return (
    <SlotBoundary entry={entry} slot="toolCard">
      <div className="pi-plugin-tool-card" data-pi-tool={message.toolName}>
        {createElement(entry.component as ComponentType<Record<string, unknown>>, committed)}
      </div>
    </SlotBoundary>
  );
}
