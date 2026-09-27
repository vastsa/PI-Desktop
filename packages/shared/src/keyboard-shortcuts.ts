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
  "closeWindow",
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
  { id: "closeWindow", group: "window", defaultBinding: "Mod+W" },
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
