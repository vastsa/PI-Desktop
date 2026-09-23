/**
 * The `completionSource` position: a plugin's candidates inside the composer's
 * completion popover.
 *
 * Mounted in the popover's candidate list, below the host's own rows, so the
 * host's commands and file paths keep working and keep their order and a plugin
 * contributes after them (D8). It is rendered while the popover is open only:
 * the component it mounts is gone as soon as the popover closes, and with
 * nothing registered the list is exactly what the host drew.
 */
import { useMemo } from "react";
import { PluginSlot } from "../../../plugins/renderer-slots/SlotOutlet";
import { useRendererCandidates } from "../../../plugins/renderer-slots/use-renderer-candidates";

export function CompletionSourceSlot({
  mode,
  query,
  sessionId,
  acceptText,
}: {
  /** The trigger the popover is open for. */
  mode: "slash" | "file";
  /** What the user has typed after that trigger. */
  query: string;
  sessionId?: string;
  acceptText?: (text: string) => boolean;
}) {
  const candidates = useRendererCandidates();
  const slotProps = useMemo(() => ({ mode, query, sessionId, acceptText }), [mode, query, sessionId, acceptText]);
  return (
    <PluginSlot
      slot="completionSource"
      slotProps={slotProps}
      candidates={candidates}
      containerProps={{ "data-pi-completion-mode": mode }}
    />
  );
}
