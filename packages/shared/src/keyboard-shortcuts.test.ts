import { describe, expect, it } from "vitest";
import {
  KEYBOARD_SHORTCUTS,
  isAllowedKeybinding,
  isReservedKeybinding,
  keybindingDisplayParts,
  keybindingFromEvent,
  keybindingMatchesEvent,
  keybindingToElectronAccelerator,
  keybindingsConflict,
  normalizeKeybinding,
  resolveKeybinding,
} from "./keyboard-shortcuts.js";

describe("keyboard shortcut mapping", () => {
  it("normalizes modifiers and rejects malformed values", () => {
    expect(normalizeKeybinding("Shift+Mod+p")).toBe("Mod+Shift+P");
    expect(normalizeKeybinding("Mod+Comma")).toBe("Mod+Comma");
    expect(normalizeKeybinding("Unknown+K")).toBeNull();
    expect(normalizeKeybinding("Mod+Escape")).toBeNull();
  });

  it("uses platform defaults and valid overrides", () => {
    const fullscreen = KEYBOARD_SHORTCUTS.find(
      (shortcut) => shortcut.id === "toggleFullScreen",
    )!;
    expect(resolveKeybinding(fullscreen, undefined, "darwin")).toBe("Mod+Ctrl+F");
    expect(resolveKeybinding(fullscreen, undefined, "win32")).toBe("F11");
    expect(resolveKeybinding(fullscreen, { toggleFullScreen: "Mod+Shift+F" }, "linux"))
      .toBe("Mod+Shift+F");
    expect(resolveKeybinding(fullscreen, { toggleFullScreen: "bad" }, "linux")).toBe(
      "F11",
    );
  });

  it("keeps explicit null overrides unbound", () => {
    const search = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "openSearch")!;
    expect(resolveKeybinding(search, undefined, "darwin")).toBe("Mod+K");
    expect(resolveKeybinding(search, { openSearch: null }, "darwin")).toBeNull();
    expect(
      keybindingMatchesEvent(
        null,
        { key: "k", code: "KeyK", metaKey: true },
        "darwin",
      ),
    ).toBe(false);
    expect(keybindingsConflict(null, "Mod+K")).toBe(false);
    expect(keybindingToElectronAccelerator(null, "darwin")).toBeUndefined();
    expect(keybindingDisplayParts(null, "darwin")).toEqual([]);
  });

  it("assigns Cmd/Ctrl+J to opening the work panel", () => {
    const workPanel = KEYBOARD_SHORTCUTS.find(
      (shortcut) => shortcut.id === "openWorkPanel",
    )!;
    expect(workPanel.defaultBinding).toBe("Mod+J");
    expect(resolveKeybinding(workPanel, undefined, "darwin")).toBe("Mod+J");
    expect(
      keybindingMatchesEvent(
        "Mod+J",
        { key: "j", code: "KeyJ", ctrlKey: true },
        "win32",
      ),
    ).toBe(true);
  });

  it("assigns Option/Alt+Space to the global plugin launcher", () => {
    const launcher = KEYBOARD_SHORTCUTS.find(
      (shortcut) => shortcut.id === "openPluginLauncher",
    )!;
    expect(launcher.defaultBinding).toBe("Alt+Space");
    expect(resolveKeybinding(launcher, undefined, "darwin")).toBe("Alt+Space");
    expect(keybindingDisplayParts("Alt+Space", "darwin")).toEqual(["⌥", "Space"]);
    expect(keybindingDisplayParts("Alt+Space", "win32")).toEqual(["Alt", "Space"]);
    expect(keybindingToElectronAccelerator("Alt+Space", "win32")).toBe(
      "Alt+Space",
    );
  });

  it("converts DOM keyboard events into portable bindings", () => {
    expect(
      keybindingFromEvent(
        { key: "K", code: "KeyK", metaKey: true },
        "darwin",
      ),
    ).toBe("Mod+K");
    expect(
      keybindingFromEvent(
        { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true },
        "win32",
      ),
    ).toBe("Mod+Shift+P");
    expect(
      keybindingMatchesEvent(
        "Mod+Comma",
        { key: ",", code: "Comma", ctrlKey: true },
        "linux",
      ),
    ).toBe(true);
    expect(
      keybindingMatchesEvent(
        "Mod+BracketLeft",
        { key: "[", code: "BracketLeft", metaKey: true },
        "darwin",
      ),
    ).toBe(true);
    expect(
      keybindingMatchesEvent(
        "Mod+Equal",
        { key: "+", code: "Equal", ctrlKey: true, shiftKey: true },
        "win32",
      ),
    ).toBe(true);
  });

  it("never treats a modifier-only event as a shortcut", () => {
    for (const event of [
      { key: "Control", code: "ControlLeft", ctrlKey: true },
      { key: "Meta", code: "MetaLeft", metaKey: true },
      { key: "Shift", code: "ShiftLeft", shiftKey: true },
      { key: "Alt", code: "AltLeft", altKey: true },
      { key: "[", code: "ControlLeft", ctrlKey: true },
    ]) {
      expect(keybindingFromEvent(event, "win32")).toBeNull();
      expect(keybindingMatchesEvent("Mod+BracketLeft", event, "win32")).toBe(false);
    }
    expect(
      keybindingMatchesEvent(
        "Mod+BracketLeft",
        { key: "Unidentified", code: "", ctrlKey: true },
        "win32",
      ),
    ).toBe(false);
    expect(
      keybindingMatchesEvent(
        "not-a-binding",
        { key: "Unidentified", code: "" },
        "win32",
      ),
    ).toBe(false);
  });

  it("requires a modifier except for function keys", () => {
    expect(isAllowedKeybinding("K")).toBe(false);
    expect(isAllowedKeybinding("Mod+K")).toBe(true);
    expect(isAllowedKeybinding("F11")).toBe(true);
    expect(isReservedKeybinding("Mod+C", "darwin")).toBe(true);
    expect(isReservedKeybinding("Mod+Enter", "linux")).toBe(true);
    expect(isReservedKeybinding("Alt+F4", "win32")).toBe(true);
    expect(isReservedKeybinding("Mod+Shift+P", "darwin")).toBe(false);
  });

  it("treats shifted and unshifted Equal bindings as conflicting", () => {
    expect(keybindingsConflict("Mod+Equal", "Mod+Shift+Equal")).toBe(true);
    expect(keybindingsConflict("Mod+Equal", "Mod+Minus")).toBe(false);
  });

  it("produces Electron accelerators for each platform", () => {
    expect(keybindingToElectronAccelerator("Mod+Shift+P", "darwin")).toBe(
      "Command+Shift+P",
    );
    expect(keybindingToElectronAccelerator("Mod+Equal", "win32")).toBe(
      "Control+Plus",
    );
    expect(keybindingDisplayParts("Mod+Shift+P", "darwin")).toEqual(["⌘", "⇧", "P"]);
    expect(keybindingDisplayParts("Mod+Comma", "win32")).toEqual(["Ctrl", ","]);
  });
});
