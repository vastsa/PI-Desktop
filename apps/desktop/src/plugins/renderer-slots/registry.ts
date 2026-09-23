/**
 * The component-slot registry for trusted-renderer plugins (ADR 0291).
 *
 * Slots are registered at runtime, never declared in the manifest (D6), so this
 * is the single place the host learns that a plugin wants to draw somewhere. It
 * is deliberately a plain observable store rather than part of `app-store`: a
 * plugin registering a slot must not re-render the shell.
 *
 * Replace slots (`PLUGIN_RENDERER_REPLACE_SLOTS`) hold one host surface: the
 * first claim wins, and a later registration is refused with
 * `PLUGIN_SLOT_DUPLICATE` so mounts never stack full replacements.
 */
import type { ReactNode } from "react";
import {
  PLUGIN_RENDERER_COMPOSER_POSITIONS,
  type PiRendererComposerControlPosition,
  type PiRendererSlotOptions,
  type PluginRendererSlot,
} from "@pi-desktop/plugin-sdk";
import { isPluginRendererReplaceSlot } from "@pi-desktop/plugin-sdk";
import {
  codeBlockLanguageProblem,
  normalizeCodeBlockLanguage,
  type CodeBlockLanguageDiagnostic,
} from "./code-blocks";

/**
 * The layer positions: `modal` and `overlay` (spec 07-plugins/16 §2A.5).
 *
 * A layer has no place in the host's own tree, so a registration *is* the
 * claim: a plugin says its dialog or overlay is up by registering one. That
 * registration is also the only thing a layer action can act on, which is why
 * the host keeps the one piece of state the registration itself does not carry
 * — whether the layer is currently withdrawn. The host withdraws a layer on
 * Escape; the plugin withdraws or restores its own with `ui.closeModal` /
 * `ui.openModal` (and `ui.closeOverlay` / `ui.openOverlay`). The component
 * stays registered throughout, so restoring the layer shows the same one again.
 *
 * Withdrawal is per plugin and never crosses plugins: one plugin can neither
 * open nor close another plugin's layer.
 */
export const PLUGIN_LAYER_SLOTS = ["modal", "overlay"] as const;

export type PluginLayerSlot = (typeof PLUGIN_LAYER_SLOTS)[number];

export function isPluginLayerSlot(slot: PluginRendererSlot): slot is PluginLayerSlot {
  return (PLUGIN_LAYER_SLOTS as readonly string[]).includes(slot);
}

/**
 * A component a plugin handed over. The SDK types this as returning `unknown`
 * so the plugin-facing contract carries no React dependency; the host is the
 * side that knows it is rendering React, and casts here.
 */
export type PluginSlotComponent = (props: Record<string, unknown>) => ReactNode;

export type PluginSlotRegistration = {
  pluginId: string;
  slot: PluginRendererSlot;
  component: PluginSlotComponent;
  /** `codeBlock` only: the fenced language this component claimed. */
  language?: string;
  /**
   * `composerControl` only: the composer positions this registration declared,
   * absent when it declared none — which means the two control rows
   * (`PLUGIN_RENDERER_COMPOSER_DEFAULT_POSITIONS`). The registry normalizes and
   * refuses a bad list, so a mount can compare against it directly.
   */
  positions?: readonly PiRendererComposerControlPosition[];
  validateSend?: PiRendererSlotOptions["validateSend"];
};

/**
 * Something a plugin tried that the host will not honour. Registration
 * failures and refused dispatches are never silent (D6/D12, ADR 0294): the
 * plugins page and the diagnostics list read these, so a plugin author sees
 * why nothing appeared or why a call was refused.
 */
export type PluginSlotDiagnostic = {
  pluginId: string;
  slot?: PluginRendererSlot;
  /**
   * A refused dispatch carries its own code. A layer position
   * (`PLUGIN_LAYER_SLOTS`) whose action names a registration the plugin does
   * not hold is reported as `PLUGIN_ACTION_LAYER_NOT_REGISTERED`, and a
   * `composer.readDraft` with no active session as `NO_SESSION`.
   */
  code:
    | "PLUGIN_SLOT_NOT_DECLARED"
    | "PLUGIN_SLOT_INVALID_COMPONENT"
    | "PLUGIN_SLOT_DUPLICATE"
    | "PLUGIN_SLOT_INVALID_POSITION"
    | "PLUGIN_DATA_UNSERVED"
    | "PLUGIN_STYLE_REFUSED"
    | "PLUGIN_STYLE_SCOPED"
    | "PLUGIN_STYLE_PRIVATE_TOKEN"
    | CodeBlockLanguageDiagnostic
    | "PLUGIN_SLOT_RENDER_FAILED"
    | "PLUGIN_SLOT_LOAD_FAILED"
    | "PLUGIN_ACTION_UNDECLARED"
    | "PLUGIN_ACTION_UNROUTED"
    | "PLUGIN_ACTION_INVALID_PAYLOAD"
    | "PLUGIN_ACTION_DRAFT_UNCONSUMED"
    | "PLUGIN_ACTION_LAYER_NOT_REGISTERED"
    | "NO_SESSION"
    | "DRAFT_CONFLICT"
    | "PLUGIN_CALL_INVALID"
    | "PLUGIN_CALL_UNKNOWN_PLUGIN"
    | "PLUGIN_CALL_UNDECLARED"
    | "PLUGIN_CALL_NO_ENTRY"
    | "PLUGIN_CALL_NO_PROCESS"
    | "PLUGIN_CALL_TIMEOUT"
    | "PLUGIN_CALL_NO_HANDLER"
    | "PLUGIN_CALL_UNSERIALIZABLE"
    | "PLUGIN_CALL_FAILED"
    | "PLUGIN_FUNCTION_INVALID_NAME"
    | "PLUGIN_FUNCTION_DUPLICATE_NAME"
    | "PLUGIN_FUNCTION_MISSING"
    | "PLUGIN_FUNCTION_THREW"
    | "PLUGIN_FUNCTION_OVER_BUDGET"
    | "PLUGIN_FUNCTION_DISABLED"
    | "PLUGIN_INVALID: renderer entry must export onLoad";
  detail?: string;
  ts: number;
};

const KEY_SEP = String.fromCharCode(0);

function keyFor(pluginId: string, slot: PluginRendererSlot): string {
  return pluginId + KEY_SEP + slot;
}

/** True for a value from the SDK's published composer-position vocabulary. */
function isComposerPosition(value: unknown): value is PiRendererComposerControlPosition {
  return (PLUGIN_RENDERER_COMPOSER_POSITIONS as readonly unknown[]).includes(value);
}

class PluginSlotRegistry {
  /** Keyed by `(pluginId, slot)`, each list in registration order. */
  private readonly registrations = new Map<string, PluginSlotRegistration[]>();

  private readonly diagnostics: PluginSlotDiagnostic[] = [];

  /**
   * Keyed by `(pluginId, slot)`: layer positions whose appearance the host has
   * withdrawn while the registration stands (`PLUGIN_LAYER_SLOTS`). A fresh
   * registration for that key clears it, so a plugin registering its layer
   * again — or dismissing and re-opening it through its own actions — always
   * ends up with a layer that is on screen.
   */
  private readonly withdrawnLayers = new Set<string>();

  private readonly listeners = new Set<() => void>();

  private version = 0;

  /**
   * Registers one component. Returns the handle the plugin uses to withdraw it,
   * or null when the host refused the registration — `codeBlock` additionally
   * needs the language it claims, which must be namespaced with its own id, and
   * `composerControl` may declare the composer positions it wants to be asked
   * for, where `beforeSend` is one claim.
   */
  register(
    pluginId: string,
    slot: PluginRendererSlot,
    component: unknown,
    options?: PiRendererSlotOptions,
  ): { remove(): void } | null {
    if (typeof component !== "function") {
      this.report({
        pluginId,
        slot,
        code: "PLUGIN_SLOT_INVALID_COMPONENT",
        detail: `expected a component, received ${typeof component}`,
      });
      return null;
    }
    if (options?.validateSend !== undefined &&
        (slot !== "composerReference" || typeof options.validateSend !== "function")) {
      this.report({ pluginId, slot, code: "PLUGIN_SLOT_INVALID_COMPONENT",
        detail: "validateSend must be a function on composerReference" });
      return null;
    }
    let language: string | undefined;
    let positions: readonly PiRendererComposerControlPosition[] | undefined;
    if (slot === "codeBlock") {
      language = normalizeCodeBlockLanguage(options?.language);
      const problem = codeBlockLanguageProblem(pluginId, language);
      if (problem) {
        this.report({ pluginId, slot, code: problem.code, detail: problem.detail });
        return null;
      }
    } else if (isPluginRendererReplaceSlot(slot)) {
      const suffix = KEY_SEP + slot;
      for (const [entryKey, list] of this.registrations) {
        if (entryKey.endsWith(suffix) && list.length > 0) {
          this.report({
            pluginId,
            slot,
            code: "PLUGIN_SLOT_DUPLICATE",
            detail: `slot is already claimed by ${list[0].pluginId}`,
          });
          return null;
        }
      }
    } else if (slot === "composerControl" && options?.positions !== undefined) {
      const declared: unknown = options.positions;
      if (
        !Array.isArray(declared) ||
        declared.length === 0 ||
        !declared.every(isComposerPosition)
      ) {
        this.report({
          pluginId,
          slot,
          code: "PLUGIN_SLOT_INVALID_POSITION",
          detail: `options.positions must be a non-empty list of ${PLUGIN_RENDERER_COMPOSER_POSITIONS.join(" | ")}`,
        });
        return null;
      }
      positions = [...new Set(declared)];
      // `beforeSend` is one claim: the host hands that region over whole, so a
      // second component there would draw a second copy of the host's own
      // controls. `left` and `right` stay additive, as they always were.
      if (positions.includes("beforeSend")) {
        const owner = this.list("composerControl").find((registration) =>
          registration.positions?.includes("beforeSend"),
        );
        if (owner) {
          this.report({
            pluginId,
            slot,
            code: "PLUGIN_SLOT_DUPLICATE",
            detail: `the beforeSend composer position is already claimed by ${owner.pluginId}`,
          });
          return null;
        }
      }
    }
    const key = keyFor(pluginId, slot);
    const list = this.registrations.get(key) ?? [];
    const entry: PluginSlotRegistration = {
      pluginId,
      slot,
      component: component as PluginSlotComponent,
      ...(language === undefined ? {} : { language }),
      ...(positions === undefined ? {} : { positions }),
      ...(options?.validateSend === undefined ? {} : { validateSend: options.validateSend }),
    };
    list.push(entry);
    this.registrations.set(key, list);
    // A new claim on a layer position is a layer on screen: the withdrawal
    // belonged to the registration this one replaces.
    if (isPluginLayerSlot(slot)) this.withdrawnLayers.delete(key);
    this.changed();
    return {
      remove: () => {
        const current = this.registrations.get(key);
        if (!current) return;
        const next = current.filter((candidate) => candidate !== entry);
        if (next.length) this.registrations.set(key, next);
        else this.registrations.delete(key);
        // With nothing left to withdraw, the state goes with the registration.
        if (!next.length) this.withdrawnLayers.delete(key);
        this.changed();
      },
    };
  }

  /** Every registration for one slot, across plugins, in registration order. */
  list(slot: PluginRendererSlot): PluginSlotRegistration[] {
    const out: PluginSlotRegistration[] = [];
    const suffix = KEY_SEP + slot;
    for (const [key, list] of this.registrations) {
      if (key.endsWith(suffix)) out.push(...list);
    }
    return out;
  }

  /**
   * Announces that renderer state a plugin owns changed outside this
   * registry — the loader reports a module becoming live, or being disposed —
   * so a surface that reads both re-renders. Nothing here is added or removed:
   * the version is the same signal subscribers already compare, and the plugins
   * page reads it beside `isRendererPluginLoaded` for exactly this reason.
   */
  notifyRendererStateChanged(): void {
    this.changed();
  }

  /** True while this plugin holds a live registration for that layer position. */
  hasLayer(pluginId: string, slot: PluginLayerSlot): boolean {
    return (this.registrations.get(keyFor(pluginId, slot))?.length ?? 0) > 0;
  }

  /** True while the host has withdrawn this plugin's own layer position. */
  isLayerWithdrawn(pluginId: string, slot: PluginLayerSlot): boolean {
    return this.withdrawnLayers.has(keyFor(pluginId, slot));
  }

  /**
   * Withdraws or restores one plugin's own layer position, keyed by the plugin
   * that asked: the state is per plugin, so no caller can reach another
   * plugin's layer.
   *
   * Answers `false` when the plugin holds no registration there — a layer this
   * plugin never registered cannot be opened or closed, and the caller refuses
   * the action with `PLUGIN_ACTION_LAYER_NOT_REGISTERED` rather than pretending.
   * Asking for the state a layer already has is a no-op.
   */
  setLayerWithdrawn(pluginId: string, slot: PluginLayerSlot, withdrawn: boolean): boolean {
    if (!this.hasLayer(pluginId, slot)) return false;
    const key = keyFor(pluginId, slot);
    if (this.withdrawnLayers.has(key) === withdrawn) return true;
    if (withdrawn) this.withdrawnLayers.add(key);
    else this.withdrawnLayers.delete(key);
    this.changed();
    return true;
  }

  /** Everything a plugin owns, dropped on unload / disable / uninstall (D10). */
  unregisterPlugin(pluginId: string): void {
    let touched = false;
    const prefix = pluginId + KEY_SEP;
    for (const [key, list] of [...this.registrations]) {
      if (!key.startsWith(prefix)) continue;
      this.registrations.delete(key);
      touched = touched || list.length > 0;
    }
    // A withdrawn layer belongs to the plugin that owns it, so it goes with
    // everything else that plugin held.
    for (const key of [...this.withdrawnLayers]) {
      if (!key.startsWith(prefix)) continue;
      this.withdrawnLayers.delete(key);
      touched = true;
    }
    if (touched) this.changed();
  }

  /** How many slots a plugin currently occupies, for the diagnostics surface. */
  countFor(pluginId: string): number {
    let total = 0;
    const prefix = pluginId + KEY_SEP;
    for (const [key, list] of this.registrations) {
      if (key.startsWith(prefix)) total += list.length;
    }
    return total;
  }

  report(diagnostic: Omit<PluginSlotDiagnostic, "ts"> & { ts?: number }): void {
    this.diagnostics.push({ ts: Date.now(), ...diagnostic });
    if (this.diagnostics.length > 200) this.diagnostics.splice(0, this.diagnostics.length - 200);
    this.changed();
  }

  listDiagnostics(pluginId?: string): PluginSlotDiagnostic[] {
    return pluginId
      ? this.diagnostics.filter((entry) => entry.pluginId === pluginId)
      : [...this.diagnostics];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable within a version, so `useSyncExternalStore` can compare snapshots. */
  snapshot = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  /** Test seam: drop every registration and diagnostic. */
  reset(): void {
    this.registrations.clear();
    this.diagnostics.length = 0;
    this.withdrawnLayers.clear();
    this.changed();
  }
}

export const pluginSlots = new PluginSlotRegistry();

/** Test seam: back to a registry no plugin has ever touched. */
export function resetPluginSlots(): void {
  pluginSlots.reset();
}
