/**
 * System-wide accelerators owned by plugins (permission
 * `keyboard.globalShortcut`).
 *
 * A plugin never reaches Electron's `globalShortcut`: it asks for
 * `accelerator -> one of its own commands`, and the host decides whether the
 * accelerator is free, registers it, and turns a trigger back into a command
 * run. Two consequences are deliberate:
 *
 * - Registration is refused rather than faked. When the OS, the host, or
 *   another plugin already spends an accelerator, the caller gets a code and
 *   keeps its own accelerator, so nothing is silently stolen.
 * - Every entry dies with its plugin: `releasePlugin` is called from the same
 *   teardown path that clears commands and tools.
 *
 * The class owns no Electron import of its own, so the registry can be driven
 * by a stub in tests and by the real `globalShortcut` in the app.
 */
import {
  KEYBOARD_SHORTCUTS,
  isAllowedKeybinding,
  isReservedKeybinding,
  keybindingToElectronAccelerator,
  normalizeKeybinding,
  type ShortcutPlatform,
} from "@pi-desktop/shared";

/** A voice assistant needs a handful of accelerators, not a keyboard map. */
export const MAX_PLUGIN_GLOBAL_SHORTCUTS = 8;

/**
 * Host shortcut ids that are registered with `globalShortcut` (see
 * `bootstrap/launcher.ts`); everything else in `KEYBOARD_SHORTCUTS` is
 * renderer-scoped and cannot conflict with a system-wide binding.
 */
const HOST_GLOBAL_SHORTCUT_IDS = ["openPluginLauncher", "toggleWindow"] as const;

export type PluginShortcutErrorCode =
  | "INVALID_ACCELERATOR"
  | "SHORTCUT_CONFLICT"
  | "SHORTCUT_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND";

/** Thrown for every refusal; `code` is what the plugin sees as `error`. */
export class PluginShortcutError extends Error {
  readonly code: PluginShortcutErrorCode;

  constructor(code: PluginShortcutErrorCode, message: string) {
    super(message);
    this.name = "PluginShortcutError";
    this.code = code;
  }
}

export type PluginShortcutEntry = {
  pluginId: string;
  /** Plugin-local id from the request or from `contributes.globalShortcuts`. */
  id: string;
  /** Canonical binding (`Alt+Space`), not the platform's accelerator spelling. */
  accelerator: string;
  electronAccelerator: string;
  command: string;
};

export type PluginShortcutDependencies = {
  /** Electron `globalShortcut.register`; false means the platform refused it. */
  register: (accelerator: string, handler: () => void) => boolean;
  unregister: (accelerator: string) => void;
  /** Runs one of the plugin's own commands for a trigger. */
  onTrigger: (entry: PluginShortcutEntry) => void;
  platform: ShortcutPlatform;
  /** Optional diagnostics sink; never used for control flow. */
  onRefused?: (entry: { pluginId: string; accelerator: string; code: PluginShortcutErrorCode }) => void;
  maxPerPlugin?: number;
  /**
   * Bindings the app currently holds for its own shortcuts, in binding form
   * (`bootstrap/launcher.ts` `hostGlobalShortcutBindings`). Supplying it makes
   * that live set authoritative; omitting it falls back to the shipped
   * defaults of the two globally registered app shortcuts.
   */
  hostBindings?: () => readonly string[];
};

export class PluginShortcutRegistry {
  /** Keyed by `pluginId\u0000id`; also the order entries were registered in. */
  private readonly entries = new Map<string, PluginShortcutEntry>();
  /** Canonical binding -> owner key, so conflicts are decided in one place. */
  private readonly owners = new Map<string, string>();
  private readonly deps: PluginShortcutDependencies;
  private readonly maxPerPlugin: number;

  constructor(deps: PluginShortcutDependencies) {
    this.deps = deps;
    this.maxPerPlugin = deps.maxPerPlugin ?? MAX_PLUGIN_GLOBAL_SHORTCUTS;
  }

  /**
   * Take `accelerator` for one of `pluginId`'s own commands. Re-registering the
   * same `id` replaces the previous accelerator, which is what a plugin
   * changing its binding at runtime means.
   */
  register(request: {
    pluginId: string;
    id: string;
    accelerator: string;
    command: string;
  }): PluginShortcutEntry {
    const { pluginId, id, command } = request;
    const key = entryKey(pluginId, id);
    const accelerator = normalizeKeybinding(request.accelerator);
    if (!accelerator || !isAllowedKeybinding(accelerator)) {
      throw this.refuse(
        { pluginId, accelerator: request.accelerator, code: "INVALID_ACCELERATOR" },
        new PluginShortcutError(
          "INVALID_ACCELERATOR",
          `accelerator is not a valid shortcut: ${request.accelerator}`,
        ),
      );
    }
    if (isReservedKeybinding(accelerator, this.deps.platform)) {
      throw this.refuse(
        { pluginId, accelerator, code: "SHORTCUT_CONFLICT" },
        new PluginShortcutError(
          "SHORTCUT_CONFLICT",
          `${accelerator} is reserved by the system`,
        ),
      );
    }
    if (this.hostOwned(accelerator)) {
      throw this.refuse(
        { pluginId, accelerator, code: "SHORTCUT_CONFLICT" },
        new PluginShortcutError(
          "SHORTCUT_CONFLICT",
          `${accelerator} is already used by PI-Desktop`,
        ),
      );
    }

    const owner = this.owners.get(accelerator);
    if (owner !== undefined && owner !== key) {
      // Same accelerator, another owner: the incumbent keeps it. A plugin that
      // wants it back can only ask again after the other side releases it.
      throw this.refuse(
        { pluginId, accelerator, code: "SHORTCUT_CONFLICT" },
        new PluginShortcutError(
          "SHORTCUT_CONFLICT",
          `${accelerator} is already registered by another plugin`,
        ),
      );
    }
    if (!this.entries.has(key) && this.countFor(pluginId) >= this.maxPerPlugin) {
      throw this.refuse(
        { pluginId, accelerator, code: "LIMIT_EXCEEDED" },
        new PluginShortcutError(
          "LIMIT_EXCEEDED",
          `a plugin may register at most ${this.maxPerPlugin} global shortcuts`,
        ),
      );
    }

    const electronAccelerator = keybindingToElectronAccelerator(
      accelerator,
      this.deps.platform,
    );
    if (!electronAccelerator) {
      throw this.refuse(
        { pluginId, accelerator, code: "INVALID_ACCELERATOR" },
        new PluginShortcutError(
          "INVALID_ACCELERATOR",
          `accelerator cannot be mapped on this platform: ${accelerator}`,
        ),
      );
    }

    const previous = this.entries.get(key);
    if (previous) this.release(previous);
    const entry: PluginShortcutEntry = {
      pluginId,
      id,
      accelerator,
      electronAccelerator,
      command,
    };
    const registered = this.deps.register(electronAccelerator, () => {
      // A throw here would unwind into the native event loop; a failed command
      // run is the plugin's problem, not a reason to lose the shortcut.
      try {
        this.deps.onTrigger(entry);
      } catch {
        // Swallowed on purpose; the caller audits failures.
      }
    });
    if (!registered) {
      throw this.refuse(
        { pluginId, accelerator, code: "SHORTCUT_UNAVAILABLE" },
        new PluginShortcutError(
          "SHORTCUT_UNAVAILABLE",
          `${accelerator} could not be registered with the operating system`,
        ),
      );
    }
    this.entries.set(key, entry);
    this.owners.set(accelerator, key);
    return entry;
  }

  /** Drop one entry; returns false when the plugin never held that id. */
  unregister(pluginId: string, id: string): boolean {
    const key = entryKey(pluginId, id);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.release(entry);
    return true;
  }

  /** Drop every entry of one plugin. Safe to call for an unknown plugin. */
  releasePlugin(pluginId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.pluginId === pluginId) this.release(entry);
    }
  }

  /** Entries this plugin currently holds, in registration order. */
  list(pluginId: string): PluginShortcutEntry[] {
    return [...this.entries.values()].filter((entry) => entry.pluginId === pluginId);
  }

  /** Every held accelerator; used by diagnostics, never by the plugin path. */
  accelerators(): string[] {
    return [...this.entries.values()].map((entry) => entry.accelerator);
  }

  private release(entry: PluginShortcutEntry): void {
    const key = entryKey(entry.pluginId, entry.id);
    this.entries.delete(key);
    if (this.owners.get(entry.accelerator) === key) {
      this.owners.delete(entry.accelerator);
    }
    try {
      this.deps.unregister(entry.electronAccelerator);
    } catch {
      // Teardown is best effort: a wedged platform call must not block unload.
    }
  }

  private countFor(pluginId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.pluginId === pluginId) count += 1;
    }
    return count;
  }

  /**
   * True when the app itself already spends this accelerator. A live launcher
   * reports the bindings it actually holds, so an accelerator the user has
   * rebound away is available again; without that source (tests, headless
   * hosts) the shipped defaults still count as spent. Fields are assigned in
   * the constructor rather than declared as parameters: the plugin tests load
   * this module with Node's strip-only TypeScript import.
   */
  private hostOwned(accelerator: string): boolean {
    const live = this.deps.hostBindings?.();
    const candidates =
      live && live.length > 0 ? live : defaultHostBindings(this.deps.platform);
    return candidates.some((binding) => normalizeKeybinding(binding) === accelerator);
  }

  private refuse(
    info: { pluginId: string; accelerator: string; code: PluginShortcutErrorCode },
    error: PluginShortcutError,
  ): PluginShortcutError {
    this.deps.onRefused?.(info);
    return error;
  }
}

function entryKey(pluginId: string, id: string): string {
  return `${pluginId}\u0000${id}`;
}

/** Shipped defaults of the app shortcuts that are registered process-wide. */
function defaultHostBindings(platform: ShortcutPlatform): string[] {
  const out: string[] = [];
  for (const id of HOST_GLOBAL_SHORTCUT_IDS) {
    const shortcut = KEYBOARD_SHORTCUTS.find((candidate) => candidate.id === id);
    if (!shortcut) continue;
    out.push(
      platform === "darwin" && shortcut.macDefaultBinding
        ? shortcut.macDefaultBinding
        : shortcut.defaultBinding,
    );
  }
  return out;
}
