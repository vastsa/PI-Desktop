/**
 * Resolution for the opt-in radial context menu on the empty transcript
 * background.
 *
 * The setting is data, not component state: the menu reads a resolved shape so
 * an absent object, an unknown action from a newer build, or a partial write
 * all still produce four usable directions. `enabled` is deliberately opt-in —
 * upgrading must not replace the vertical menu users already point at.
 */
import {
  DEFAULT_RADIAL_MENU_SLOTS,
  isRadialMenuAction,
  RADIAL_MENU_DIRECTIONS,
  type AppSettings,
  type RadialMenuAction,
  type RadialMenuDirection,
} from "@pi-desktop/shared";

/** Translation key per action, shared by the settings pickers and the ring. */
export {
  RADIAL_MENU_ACTIONS,
  RADIAL_MENU_DIRECTIONS,
} from "@pi-desktop/shared";

export const RADIAL_MENU_ACTION_LABEL_KEYS: Record<RadialMenuAction, string> = {
  "copy-conversation": "chat.copyConversation",
  "select-conversation": "chat.selectConversationText",
  "copy-last-answer": "chat.copyLastAnswer",
  "scroll-top": "chat.scrollToTop",
  "scroll-bottom": "chat.scrollToBottom",
  "open-browser": "chat.radialMenuOpenBrowser",
  "open-work-panel": "chat.radialMenuOpenWorkPanel",
  "open-project-folder": "chat.radialMenuOpenProjectFolder",
  none: "settings.radialMenuActionNone",
};

/** Row titles for the four settings pickers. */
export const RADIAL_MENU_DIRECTION_LABEL_KEYS: Record<
  RadialMenuDirection,
  string
> = {
  up: "settings.radialMenuUp",
  right: "settings.radialMenuRight",
  down: "settings.radialMenuDown",
  left: "settings.radialMenuLeft",
};

export type ResolvedRadialMenu = {
  enabled: boolean;
  slots: Record<RadialMenuDirection, RadialMenuAction>;
};

export function resolveRadialMenu(
  settings: Pick<AppSettings, "radialMenu"> | null | undefined,
): ResolvedRadialMenu {
  const raw = settings?.radialMenu;
  const slots = {} as Record<RadialMenuDirection, RadialMenuAction>;
  for (const direction of RADIAL_MENU_DIRECTIONS) {
    slots[direction] = isRadialMenuAction(raw?.[direction])
      ? (raw?.[direction] as RadialMenuAction)
      : DEFAULT_RADIAL_MENU_SLOTS[direction];
  }
  return { enabled: raw?.enabled === true, slots };
}
