/**
 * The sidebar's floating menu surface, as data.
 *
 * A row menu, the sort popover, and a section menu were three hand-written
 * bodies growing in `Sidebar.tsx`. They are one grammar — a floating panel of
 * rows, each either a command, a check, or a labeled group — so the surface is
 * declared as a value here and rendered by `SidebarMenuPanel`. Building the
 * value stays where the actions live (the sidebar), which keeps this module
 * pure and testable while the panel keeps one keyboard and focus contract for
 * every menu.
 */

/** A command row. `danger` paints destructive ink; `separatorBefore` adds a rule. */
export type SidebarMenuActionItem = {
  kind: "action";
  /** Stable identity for tests and React keys. */
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Full label for a row whose text is clamped, and its accessible name. */
  title?: string;
  danger?: boolean;
  /** Second, confirming click is armed: the item relabels and highlights. */
  armed?: boolean;
  /** Explains a disabled row (availability reason) to assistive tech. */
  describedBy?: string;
  busy?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
};

/** A labeled toggle, e.g. "Show archived". */
export type SidebarMenuCheckItem = {
  kind: "check";
  id: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
};

/** One option of a radio group, e.g. a sort order. */
export type SidebarMenuRadioOption = {
  id: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

/**
 * A labeled group. Rendered as a titled section, or — with a single option and
 * no title — as nothing but its rows, which is how a lone secondary action
 * joins the rows above it instead of opening a one-row submenu.
 */
export type SidebarMenuGroupItem = {
  kind: "group";
  id: string;
  label?: string;
  options: SidebarMenuRadioOption[];
};
/** A hover/click-opened second-level menu of commands. */
export type SidebarMenuSubmenuItem = {
  kind: "submenu";
  id: string;
  label: string;
  icon?: React.ReactNode;
  items: SidebarMenuActionItem[];
  notes?: SidebarMenuNote[];
};


/** A titled separator, e.g. "Danger zone". */
export type SidebarMenuSectionItem = {
  kind: "section";
  id: string;
  label: string;
};

export type SidebarMenuItem =
  | SidebarMenuActionItem
  | SidebarMenuCheckItem
  | SidebarMenuSectionItem
  | SidebarMenuGroupItem
  | SidebarMenuSubmenuItem;

/** A rule carrying a caption: pending work that would be lost by deleting. */
export type SidebarMenuNote = {
  id: string;
  text: string;
  /** Measured line by the caller; the panel only places it. */
  separatorBefore?: boolean;
};

/** Accessible name of the surface, and the optional hint row under it. */
export type SidebarMenuPanelContent = {
  label: string;
  hint?: string;
  items: SidebarMenuItem[];
  notes?: SidebarMenuNote[];
};

export function sidebarMenuAction(
  item: Omit<SidebarMenuActionItem, "kind">,
): SidebarMenuActionItem {
  return { kind: "action", ...item };
}

export function sidebarMenuCheck(
  item: Omit<SidebarMenuCheckItem, "kind">,
): SidebarMenuCheckItem {
  return { kind: "check", ...item };
}

export function sidebarMenuGroup(
  item: Omit<SidebarMenuGroupItem, "kind">,
): SidebarMenuGroupItem {
  return { kind: "group", ...item };
}

export function sidebarMenuSubmenu(
  item: Omit<SidebarMenuSubmenuItem, "kind">,
): SidebarMenuSubmenuItem {
  return { kind: "submenu", ...item };
}

export function sidebarMenuSection(
  item: Omit<SidebarMenuSectionItem, "kind">,
): SidebarMenuSectionItem {
  return { kind: "section", ...item };
}

export type SidebarMenuSubmenuPlacement = { top: number; left: number };

/** Place a submenu beside its trigger, flipping left and clamping vertically. */
export function placeSidebarSubmenu(
  trigger: { top: number; left: number; right: number },
  surface: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
  gap = 0,
): SidebarMenuSubmenuPlacement {
  const maxLeft = viewport.width - surface.width - margin;
  const preferredRight = trigger.right + gap;
  const preferredLeft = preferredRight + surface.width <= viewport.width - margin
    ? preferredRight
    : trigger.left - surface.width - gap;
  const maxTop = viewport.height - surface.height - margin;
  return {
    left: Math.round(Math.max(margin, Math.min(preferredLeft, maxLeft))),
    top: Math.round(Math.max(margin, Math.min(trigger.top, maxTop))),
  };
}
