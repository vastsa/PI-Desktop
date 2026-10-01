/**
 * Props and height contract of the `entryExtra` slot
 * (`docs/plugin-plan/ui/entry-extra/`). React-free so logic tests can drive
 * it directly.
 */
import type { PluginEntryExtraSlotProps } from "@pi-desktop/plugin-sdk";

/**
 * One block's props: the reply and its ids, nothing else. Rebuilt on every
 * render of the reply (props-push).
 */
export function entryExtraSlotProps(
  message: PluginEntryExtraSlotProps["message"],
  sessionId: string,
): PluginEntryExtraSlotProps {
  return { message, messageId: message.id, sessionId };
}

/** Collapsed-state clamp: taller content fades and shows the host toggle. */
export const ENTRY_EXTRA_COLLAPSED_MAX_HEIGHT = 320;

/** Expanded state scrolls internally up to this height. */
export const ENTRY_EXTRA_EXPANDED_MAX_HEIGHT = 600;
