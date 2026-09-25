/**
 * Props and layout of the additive action slots `userAction` and
 * `assistantAction` (`docs/plugin-plan/ui/user-action/`,
 * `docs/plugin-plan/ui/assistant-action/`). React-free so logic tests can
 * drive it directly.
 *
 * The bar is 【left items】【host keys】【right items】. Each side shows at most
 * three items; the fourth onward folds into that side's host "⋯" menu, which
 * sits before the host keys on the left and last on the right. The host keys
 * never fold.
 */
import type {
  PluginActionSlotProps,
  PluginSlotMessage,
  PluginSlotPosition,
} from "@pi-desktop/plugin-sdk";

/** Visible items per side; the rest fold into the host ⋯ menu. */
export const ACTION_SLOT_VISIBLE_LIMIT = 3;

/**
 * One item's props: the message, its ids and the side it is mounted on,
 * nothing else. Rebuilt on every render of the message (props-push).
 */
export function actionSlotProps(
  message: PluginSlotMessage,
  sessionId: string,
  position: PluginSlotPosition,
): PluginActionSlotProps {
  return { message, messageId: message.id, sessionId, position };
}

/** Split one side's registrations into visible items and ⋯ overflow. */
export function splitActionSide<T>(
  entries: readonly T[],
  limit: number = ACTION_SLOT_VISIBLE_LIMIT,
): { visible: T[]; overflow: T[] } {
  return {
    visible: entries.slice(0, limit),
    overflow: entries.slice(limit),
  };
}
