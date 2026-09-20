import { describe, expect, it } from "vitest";
import {
  KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_IDS,
  isAllowedKeybinding,
  isReservedKeybinding,
  keybindingDisplayParts,
  keybindingFromEvent,
  keybindingMatchesEvent,
  keybindingToElectronAccelerator,
  keybindingsConflict,
  migrateKeybindingOverrides,
  normalizeKeybinding,
  resolveKeybinding,
} from "./keyboard-shortcuts.js";

describe("keyboard shortcut mapping", () => {
  it("declares one window toggle in the window group on the Alt+Shift+W default", () => {
    expect(KEYBOARD_SHORTCUT_IDS).toContain("toggleWindow");
    // D438: the summon/close pair is gone from the catalog, so nothing can
    // register the retired `Mod+Shift+W` chord any more.
    expect(KEYBOARD_SHORTCUT_IDS).not.toContain("summonWindow");
    expect(KEYBOARD_SHORTCUT_IDS).not.toContain("closeWindow");
    const toggle = KEYBOARD_SHORTCUTS.find(
      (shortcut) => shortcut.id === "toggleWindow",
    );
    expect(toggle).toBeDefined();
    expect(toggle!.group).toBe("window");
    expect(toggle!.defaultBinding).toBe("Alt+Shift+W");
    expect(resolveKeybinding(toggle!, undefined, "darwin")).toBe("Alt+Shift+W");
    expect(resolveKeybinding(toggle!, undefined, "win32")).toBe("Alt+Shift+W");
    expect(resolveKeybinding(toggle!, undefined, "linux")).toBe("Alt+Shift+W");
    // D439: the key is registered process-wide, so it must not be a chord the
    // platform owns. `Mod+W` closes a window on macOS and the app no longer
    // spends it anywhere.
    expect(
      KEYBOARD_SHORTCUTS.some((shortcut) => shortcut.defaultBinding === "Mod+W"),
    ).toBe(false);
    expect(isReservedKeybinding("Mod+W", "darwin")).toBe(true);
    expect(isReservedKeybinding("Alt+Shift+W", "darwin")).toBe(false);
    // One key, one binding: no shipped default may collide with it.
    for (const shortcut of KEYBOARD_SHORTCUTS) {
      if (shortcut.id === "toggleWindow") continue;
      expect(
        keybindingsConflict(
          toggle!.defaultBinding,
          resolveKeybinding(shortcut, undefined, "linux"),
        ),
      ).toBe(false);
    }
    expect(
      KEYBOARD_SHORTCUTS.some((shortcut) => shortcut.defaultBinding === "Mod+Shift+W"),
    ).toBe(false);
  });

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

describe("retired window keybindings migrate into the toggle (D438, D439)", () => {
  const toggle = () => KEYBOARD_SHORTCUTS.find((s) => s.id === "toggleWindow")!;

  it("leaves users who never customized a window key on the shipped default", () => {
    expect(migrateKeybindingOverrides(undefined)).toBeUndefined();
    expect(migrateKeybindingOverrides(null)).toBeUndefined();
    expect(migrateKeybindingOverrides({})).toBeUndefined();
    expect(
      resolveKeybinding(toggle(), migrateKeybindingOverrides({}), "darwin"),
    ).toBe("Alt+Shift+W");
  });

  it("carries a customized close binding onto the toggle key", () => {
    const migrated = migrateKeybindingOverrides({
      closeWindow: "Mod+Shift+Q",
      openSearch: "Mod+Shift+K",
    });
    expect(migrated).toEqual({
      toggleWindow: "Mod+Shift+Q",
      openSearch: "Mod+Shift+K",
    });
    expect(migrated).not.toHaveProperty("closeWindow");
    expect(migrated).not.toHaveProperty("summonWindow");
  });

  it("merges a customized summon binding into the toggle", () => {
    expect(
      migrateKeybindingOverrides({ summonWindow: "Ctrl+Alt+W" }),
    ).toEqual({ toggleWindow: "Ctrl+Alt+W" });
  });

  it("prefers the close entry when both retired keys were customized", () => {
    expect(
      migrateKeybindingOverrides({
        closeWindow: "Mod+Shift+Q",
        summonWindow: "Ctrl+Alt+W",
      }),
    ).toEqual({ toggleWindow: "Mod+Shift+Q" });
  });

  it("does not resurrect a shipped default behind an explicit unbind", () => {
    expect(migrateKeybindingOverrides({ closeWindow: null })).toEqual({
      toggleWindow: null,
    });
    // A live binding still wins over a retired unbind.
    expect(
      migrateKeybindingOverrides({ closeWindow: null, summonWindow: "Ctrl+Alt+W" }),
    ).toEqual({ toggleWindow: "Ctrl+Alt+W" });
  });

  it("ignores stored values that only repeat a retired default", () => {
    expect(migrateKeybindingOverrides({ closeWindow: "Mod+W" })).toBeUndefined();
    expect(
      migrateKeybindingOverrides({ summonWindow: "Mod+Shift+W" }),
    ).toBeUndefined();
    // The retired chord therefore never comes back, even from hand-written
    // storage.
    expect(
      migrateKeybindingOverrides({ summonWindow: "Shift+Mod+W" }),
    ).toBeUndefined();
  });

  it("frees a frozen Mod+W toggle so D439's default can apply", () => {
    // A release before D439 shipped `Mod+W`; the settings UI only stores a
    // binding a user actually chose, so an equal-to-old-default value carries no
    // intent and must not pin the toggle to the macOS close-window chord.
    expect(migrateKeybindingOverrides({ toggleWindow: "Mod+W" })).toBeUndefined();
    expect(
      resolveKeybinding(
        toggle(),
        migrateKeybindingOverrides({ toggleWindow: "Mod+W" }),
        "darwin",
      ),
    ).toBe("Alt+Shift+W");
    // A retired customization still wins over the dropped superseded default,
    // and a real customization is never rewritten.
    expect(
      migrateKeybindingOverrides({
        toggleWindow: "Mod+W",
        closeWindow: "Mod+Shift+Q",
      }),
    ).toEqual({ toggleWindow: "Mod+Shift+Q" });
    expect(
      migrateKeybindingOverrides({ toggleWindow: "Ctrl+Alt+T" }),
    ).toEqual({ toggleWindow: "Ctrl+Alt+T" });
  });

  it("drops a folded binding that lands on the shipped default", () => {
    // `Alt+Shift+W` is the current default, so it must not be persisted as an
    // override either — otherwise a later default change could never reach the
    // user again.
    expect(
      migrateKeybindingOverrides({ toggleWindow: "Alt+Shift+W" }),
    ).toBeUndefined();
    // The same value on a *retired* entry is kept as a genuine customization of
    // that retired key unless it repeats the current default too.
    expect(
      migrateKeybindingOverrides({ summonWindow: "Alt+Shift+W" }),
    ).toBeUndefined();
    // An explicit unbind is intent and always survives.
    expect(migrateKeybindingOverrides({ toggleWindow: null })).toEqual({
      toggleWindow: null,
    });
  });

  it("is idempotent and never rewrites a later rebind", () => {
    const once = migrateKeybindingOverrides({
      closeWindow: "Mod+Shift+Q",
      toggleWindow: "Mod+Shift+T",
    });
    expect(once).toEqual({ toggleWindow: "Mod+Shift+T" });
    expect(migrateKeybindingOverrides(once)).toEqual(once);
    expect(
      migrateKeybindingOverrides(
        migrateKeybindingOverrides({ summonWindow: "Ctrl+Alt+W" }),
      ),
    ).toEqual({ toggleWindow: "Ctrl+Alt+W" });
  });
});
