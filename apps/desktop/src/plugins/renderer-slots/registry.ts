/**
 * The renderer-side slot registry (`docs/plugin-plan/slot-contract.html`).
 *
 * A plugin's renderer entry registers components through `pi.slots.register`;
 * this store owns the resulting catalog. It is React-free so logic tests can
 * drive it directly; the React glue lives in `use-slots.tsx`.
 *
 * Additive slots stack in registration order and never clash. Keyed slots
 * (`toolCard` by the plugin's qualified tool name, `blockRenderer` by its
 * language tag) refuse a second claim of a key with `PLUGIN_SLOT_DUPLICATE`:
 * the first registration keeps it. Every registration comes back as a
 * disposer; the loader holds the disposers of one load and runs them all when
 * the plugin unloads.
 */
import {
  PLUGIN_SLOT_POSITIONS,
  blockRendererLanguageKey,
  pluginToolName,
  slotRegistrationRefusal,
  type PluginDisposer,
  type PluginRendererSlot,
  type PluginSlotPosition,
  type PluginSlotRegistration,
} from "@pi-desktop/plugin-sdk";
import { PluginRendererError } from "../renderer-error";

export type SlotEntry = {
  readonly id: string;
  readonly pluginId: string;
  readonly slot: PluginRendererSlot;
  /**
   * The plugin's function component. Its type admits no call: outlets render
   * it through `slotElement`, as an element that owns its hooks.
   */
  readonly component: (props: never) => unknown;
  /** Sides a positioned slot occupies, in canonical order; empty otherwise. */
  readonly sides: readonly PluginSlotPosition[];
  /**
   * Keyed slots only: the qualified agent-facing tool name
   * (`pluginToolName`) for `toolCard`, the normalized language tag for
   * `blockRenderer`. Outlets look entries up by what the transcript carries.
   */
  readonly key?: string;
  /** `toolCard` only: the bare tool name the card registered for. */
  readonly toolName?: string;
};

export type SlotRegistrySnapshot = {
  /** Bumped on every mutation; the `useSyncExternalStore` change signal. */
  readonly version: number;
  /** Registration order across plugins is the presentation order. */
  readonly entries: readonly SlotEntry[];
};

function sidesOf(registration: PluginSlotRegistration): readonly PluginSlotPosition[] {
  switch (registration.slot) {
    case "userAction":
    case "assistantAction":
    case "composerControl": {
      const wanted: readonly PluginSlotPosition[] =
        registration.positions ?? PLUGIN_SLOT_POSITIONS;
      return PLUGIN_SLOT_POSITIONS.filter((side) => wanted.includes(side));
    }
    default:
      return [];
  }
}

function keyOf(
  pluginId: string,
  registration: PluginSlotRegistration,
): Pick<SlotEntry, "key" | "toolName"> {
  if (registration.slot === "toolCard") {
    return {
      key: pluginToolName(pluginId, registration.toolName),
      toolName: registration.toolName,
    };
  }
  if (registration.slot === "blockRenderer") {
    return { key: blockRendererLanguageKey(registration.language) };
  }
  return {};
}

export class SlotRegistry {
  private state: SlotRegistrySnapshot = { version: 0, entries: [] };
  private readonly listeners = new Set<() => void>();
  private lastId = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SlotRegistrySnapshot => this.state;

  private commit(entries: readonly SlotEntry[]): void {
    this.state = { version: this.state.version + 1, entries };
    for (const listener of this.listeners) listener();
  }

  /**
   * Accept one registration of `pluginId` or throw a `PluginRendererError`
   * with a `PluginSlotErrorCode`. `ownTools` is the plugin's bare
   * `contributes.agentTools[].name` list. The disposer removes exactly this
   * registration; calling it again does nothing.
   */
  register(pluginId: string, registration: unknown, ownTools: readonly string[]): PluginDisposer {
    const refusal = slotRegistrationRefusal(pluginId, registration, ownTools);
    if (refusal) throw new PluginRendererError(refusal.code, refusal.message);
    const accepted = registration as PluginSlotRegistration;
    const keyed = keyOf(pluginId, accepted);
    if (keyed.key !== undefined) {
      const holder = this.state.entries.find(
        (entry) => entry.slot === accepted.slot && entry.key === keyed.key,
      );
      if (holder) {
        throw new PluginRendererError(
          "PLUGIN_SLOT_DUPLICATE",
          `${accepted.slot} ${JSON.stringify(keyed.key)} is already registered by ${holder.pluginId}`,
        );
      }
    }
    const entry: SlotEntry = {
      id: `slot-${++this.lastId}`,
      pluginId,
      slot: accepted.slot,
      component: accepted.component as SlotEntry["component"],
      sides: sidesOf(accepted),
      ...keyed,
    };
    this.commit([...this.state.entries, entry]);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.commit(this.state.entries.filter((candidate) => candidate !== entry));
    };
  }

  /** Every registration of a slot, in registration order. */
  entriesFor(slot: PluginRendererSlot): SlotEntry[] {
    return this.state.entries.filter((entry) => entry.slot === slot);
  }

  /** A positioned slot's registrations on one side, in registration order. */
  entriesForSide(slot: PluginRendererSlot, side: PluginSlotPosition): SlotEntry[] {
    return this.state.entries.filter(
      (entry) => entry.slot === slot && entry.sides.includes(side),
    );
  }

  /** The one registration holding a key: a tool's card, a language's renderer. */
  entryForKey(slot: PluginRendererSlot, key: string): SlotEntry | undefined {
    return this.state.entries.find((entry) => entry.slot === slot && entry.key === key);
  }
}

/** The app-wide registry the loader registers into and outlets read from. */
export const slotRegistry = new SlotRegistry();
