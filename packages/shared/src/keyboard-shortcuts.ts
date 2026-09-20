export const KEYBOARD_SHORTCUT_IDS = [
  "navigateBack",
  "navigateForward",
  "newTask",
  "openProject",
  "openSettings",
  "openSearch",
  "openCommandPalette",
  "openPluginLauncher",
  "toggleSidebar",
  "openWorkPanel",
  "abort",
  "toggleWindow",
  "resetZoom",
  "zoomIn",
  "zoomOut",
  "toggleFullScreen",
] as const;

export type KeyboardShortcutId = (typeof KEYBOARD_SHORTCUT_IDS)[number];
export type ShortcutPlatform = "darwin" | "win32" | "linux";
export type KeybindingOverrides = Partial<Record<KeyboardShortcutId, string | null>>;
export type KeyboardShortcutGroup = "navigation" | "agent" | "window";

export type KeyboardShortcutDefinition = {
  id: KeyboardShortcutId;
  group: KeyboardShortcutGroup;
  defaultBinding: string;
  macDefaultBinding?: string;
};

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutDefinition[] = [
  { id: "navigateBack", group: "navigation", defaultBinding: "Mod+BracketLeft" },
  {
    id: "navigateForward",
    group: "navigation",
    defaultBinding: "Mod+BracketRight",
  },
  { id: "newTask", group: "navigation", defaultBinding: "Mod+N" },
  { id: "openProject", group: "navigation", defaultBinding: "Mod+O" },
  { id: "openSettings", group: "navigation", defaultBinding: "Mod+Comma" },
  { id: "openSearch", group: "navigation", defaultBinding: "Mod+K" },
  {
    id: "openCommandPalette",
    group: "navigation",
    defaultBinding: "Mod+Shift+P",
  },
  {
    id: "openPluginLauncher",
    group: "navigation",
    defaultBinding: "Alt+Space",
  },
  { id: "toggleSidebar", group: "navigation", defaultBinding: "Mod+B" },
  { id: "openWorkPanel", group: "navigation", defaultBinding: "Mod+J" },
  { id: "abort", group: "agent", defaultBinding: "Mod+Period" },
  { id: "toggleWindow", group: "window", defaultBinding: "Alt+Shift+W" },
  { id: "resetZoom", group: "window", defaultBinding: "Mod+0" },
  { id: "zoomIn", group: "window", defaultBinding: "Mod+Equal" },
  { id: "zoomOut", group: "window", defaultBinding: "Mod+Minus" },
  {
    id: "toggleFullScreen",
    group: "window",
    defaultBinding: "F11",
    macDefaultBinding: "Mod+Ctrl+F",
  },
] as const;

/**
 * A keybinding map as it comes back from storage: it may still name ids an
 * older release shipped, so it is deliberately wider than
 * `KeybindingOverrides`.
 */
export type PersistedKeybindingOverrides = Record<
  string,
  string | null | undefined
>;

/**
 * Shortcut ids the window toggle replaced (D438). Both are retired outright, so
 * a stored override for either is folded into `toggleWindow` by
 * `migrateKeybindingOverrides` instead of being dropped.
 */
const RETIRED_WINDOW_SHORTCUTS = [
  // Hiding is the toggle's primary job, so a customized close binding outranks
  // a customized summon binding.
  { id: "closeWindow", defaultBinding: "Mod+W" },
  { id: "summonWindow", defaultBinding: "Mod+Shift+W" },
] as const;

/**
 * Defaults the window toggle shipped before the current one (D439). A stored
 * value that only repeats one of them carries no user intent, so the toggle
 * falls back to the default this release ships instead of freezing a superseded
 * key — which is what keeps `Mod+W`, the platform's own close-window chord, out
 * of a process-wide registration.
 */
const SUPERSEDED_TOGGLE_DEFAULTS = ["Mod+W"] as const;

/**
 * Fold the retired `closeWindow` / `summonWindow` overrides into the single
 * `toggleWindow` entry (D438) for a persisted `settings.keybindings` map, and
 * drop a stored toggle value that only repeats a default this release ships or
 * already superseded (D439).
 *
 * Rules, in order:
 *
 * - an existing `toggleWindow` override is kept as it is, so the migration is
 *   idempotent and never rewrites a later rebind — unless it only names the
 *   current default or a superseded one, which carries no user intent;
 * - otherwise the first retired entry that carries a *binding* wins, in the
 *   order above. Both are retired outright, and `closeWindow` comes first
 *   because hiding is the toggle's primary job;
 * - a retired entry that is only `null` (the user unbound it) is honoured after
 *   that: the toggle stays unbound instead of resurrecting a shipped default;
 * - a stored value equal to its retired default carries no intent (the
 *   settings UI deletes overrides that match the shipped default), so it is
 *   ignored and the new default applies. The same holds for a folded binding
 *   that lands on the current or a superseded default.
 */
export function migrateKeybindingOverrides(
  overrides:
    | KeybindingOverrides
    | PersistedKeybindingOverrides
    | null
    | undefined,
): KeybindingOverrides | undefined {
  if (!overrides || typeof overrides !== "object") return undefined;
  const legacy = overrides as PersistedKeybindingOverrides;
  const migrated: Record<string, string | null> = {};
  for (const [id, binding] of Object.entries(overrides)) {
    // A key stored without a value is not an override; JSON cannot hold one
    // either, so it never reaches the migrated map.
    if (binding === undefined) continue;
    if (RETIRED_WINDOW_SHORTCUTS.some((retired) => retired.id === id)) continue;
    migrated[id] = binding;
  }
  // A stored toggle value that only repeats the current default or a superseded
  // one is "no intent": drop it so the fold below still sees a retired
  // customization, and the current default otherwise.
  if (
    Object.prototype.hasOwnProperty.call(migrated, "toggleWindow") &&
    !carriesToggleIntent(migrated.toggleWindow)
  ) {
    delete migrated.toggleWindow;
  }
  if (!Object.prototype.hasOwnProperty.call(migrated, "toggleWindow")) {
    const inherited = inheritedToggleBinding(legacy);
    if (inherited === null) migrated.toggleWindow = null;
    else if (inherited !== undefined && carriesToggleIntent(inherited)) {
      migrated.toggleWindow = inherited;
    }
  }
  return Object.keys(migrated).length > 0
    ? (migrated as KeybindingOverrides)
    : undefined;
}

/** True for `null` (an explicit unbind) and for any binding a user chose. */
function carriesToggleIntent(value: string | null): boolean {
  if (value === null) return true;
  const binding = normalizeKeybinding(value);
  if (!binding) return false;
  const definition = KEYBOARD_SHORTCUTS.find(
    (shortcut) => shortcut.id === "toggleWindow",
  );
  if (definition && binding === normalizeKeybinding(definition.defaultBinding)) {
    return false;
  }
  return !SUPERSEDED_TOGGLE_DEFAULTS.some((superseded) => superseded === binding);
}

function inheritedToggleBinding(
  legacy: Record<string, string | null | undefined>,
): string | null | undefined {
  let unbound = false;
  for (const { id, defaultBinding } of RETIRED_WINDOW_SHORTCUTS) {
    if (!Object.prototype.hasOwnProperty.call(legacy, id)) continue;
    const value = legacy[id];
    if (value === null) {
      unbound = true;
      continue;
    }
    const binding = normalizeKeybinding(value);
    if (!binding || binding === defaultBinding) continue;
    return binding;
  }
  return unbound ? null : undefined;
}

const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const MODIFIER_KEY_VALUES = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);
const NAMED_KEYS = new Set([
  "Enter",
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Comma",
  "Period",
  "Equal",
  "Minus",
  "Slash",
  "Backslash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Backquote",
]);

export type KeyboardEventLike = {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export function defaultKeybinding(
  shortcut: KeyboardShortcutDefinition,
  platform: ShortcutPlatform,
): string {
  return platform === "darwin" && shortcut.macDefaultBinding
    ? shortcut.macDefaultBinding
    : shortcut.defaultBinding;
}

export function normalizeKeybinding(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split("+").filter(Boolean);
  if (parts.length === 0) return null;
  const key = normalizeKey(parts.at(-1) ?? "");
  if (!key) return null;
  const modifiers = new Set(parts.slice(0, -1));
  if ([...modifiers].some((part) => !MODIFIERS.has(part))) return null;
  return [...MODIFIER_ORDER.filter((part) => modifiers.has(part)), key].join("+");
}

export function resolveKeybinding(
  shortcut: KeyboardShortcutDefinition,
  overrides: KeybindingOverrides | undefined,
  platform: ShortcutPlatform,
): string | null {
  if (
    overrides &&
    Object.prototype.hasOwnProperty.call(overrides, shortcut.id) &&
    overrides[shortcut.id] === null
  ) {
    return null;
  }
  return normalizeKeybinding(overrides?.[shortcut.id]) ?? defaultKeybinding(shortcut, platform);
}

export function keybindingFromEvent(
  event: KeyboardEventLike,
  platform: ShortcutPlatform,
): string | null {
  const key = keyFromEvent(event);
  if (!key) return null;
  const modifiers: string[] = [];
  if (platform === "darwin" ? event.metaKey : event.ctrlKey) modifiers.push("Mod");
  if (platform === "darwin" && event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return normalizeKeybinding([...modifiers, key].join("+"));
}

export function keybindingMatchesEvent(
  binding: string | null | undefined,
  event: KeyboardEventLike,
  platform: ShortcutPlatform,
): boolean {
  const normalized = normalizeKeybinding(binding);
  const eventBinding = keybindingFromEvent(event, platform);
  if (!normalized || !eventBinding) return false;
  if (normalized === eventBinding) return true;
  // The physical Equal key produces either "=" or "+" depending on Shift.
  // Preserve the conventional zoom-in behavior for an unshifted Equal binding.
  return shiftedEqualVariant(normalized) === eventBinding;
}

export function keybindingsConflict(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeKeybinding(left);
  const normalizedRight = normalizeKeybinding(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return (
    shiftedEqualVariant(normalizedLeft) === normalizedRight ||
    shiftedEqualVariant(normalizedRight) === normalizedLeft
  );
}

export function isAllowedKeybinding(binding: string): boolean {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return false;
  const parts = normalized.split("+");
  const key = parts.at(-1) ?? "";
  return parts.length > 1 || /^F(?:[1-9]|1[0-2])$/.test(key);
}

export function isReservedKeybinding(
  binding: string,
  platform: ShortcutPlatform,
): boolean {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return false;
  const common = new Set([
    "Mod+A",
    "Mod+C",
    "Mod+V",
    "Mod+X",
    "Mod+Z",
    "Mod+Shift+Z",
    "Mod+R",
    "Mod+Enter",
  ]);
  if (platform === "darwin") {
    common.add("Mod+Q");
    common.add("Mod+H");
    // macOS spends Cmd+W on its own close-window command. The app used to
    // register it process-wide as the window toggle; since D439 that binding is
    // neither the default nor available to anyone else.
    common.add("Mod+W");
  } else {
    common.add("Mod+Y");
    common.add("Alt+F4");
  }
  return common.has(normalized);
}

export function keybindingToElectronAccelerator(
  binding: string | null | undefined,
  platform: ShortcutPlatform,
): string | undefined {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return undefined;
  const tokens = normalized.split("+").map((part) => {
    if (part === "Mod") return platform === "darwin" ? "Command" : "Control";
    if (part === "Ctrl") return "Control";
    if (part === "Alt") return "Alt";
    if (part === "Shift") return "Shift";
    return ELECTRON_KEY_NAMES[part] ?? part;
  });
  return tokens.join("+");
}

export function keybindingDisplayParts(
  binding: string | null | undefined,
  platform: ShortcutPlatform,
): string[] {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return [];
  const modifiers: Record<string, string> =
    platform === "darwin"
      ? { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }
      : { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
  return normalized
    .split("+")
    .map((part) => modifiers[part] ?? DISPLAY_KEY_NAMES[part] ?? part);
}

function normalizeKey(value: string): string | null {
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  if (/^F(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
  if (NAMED_KEYS.has(value)) return value;
  return null;
}

function shiftedEqualVariant(binding: string): string | null {
  return binding.endsWith("+Equal") && !binding.includes("+Shift+")
    ? binding.replace("+Equal", "+Shift+Equal")
    : null;
}

function keyFromEvent(event: KeyboardEventLike): string | null {
  const code = event.code ?? "";
  if (
    MODIFIER_KEY_VALUES.has(event.key) ||
    /^(?:Alt|Control|Meta|Shift)(?:Left|Right)$/.test(code)
  ) {
    return null;
  }
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  if (NAMED_KEYS.has(code)) return code;

  const aliases: Record<string, string> = {
    " ": "Space",
    ",": "Comma",
    ".": "Period",
    "=": "Equal",
    "+": "Equal",
    "-": "Minus",
    "/": "Slash",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "`": "Backquote",
  };
  return normalizeKey(aliases[event.key] ?? event.key);
}

const ELECTRON_KEY_NAMES: Record<string, string> = {
  Enter: "Return",
  Space: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Comma: ",",
  Period: ".",
  Equal: "Plus",
  Minus: "-",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
};

const DISPLAY_KEY_NAMES: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Equal: "=",
  Minus: "-",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
