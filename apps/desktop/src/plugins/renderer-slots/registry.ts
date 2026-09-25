/**
 * The renderer-side slot registry (`docs/plugin-plan/slot-contract.html`).
 *
 * A plugin's renderer entry registers components through `pi.slots.register`;
 * this store owns the resulting catalog. It is React-free so logic tests can
 * drive it directly; the React glue lives in `use-slots.tsx`.
 *
 * Additive slots stack in registration order and never clash. Keyed slots
 * (`toolCard` by the plugin's qualified tool name, `blockRenderer` by its
 * language tag, `composerTrigger` by its symbol) refuse a second claim of a
 * key with `PLUGIN_SLOT_DUPLICATE`: the first registration keeps it.
 * `composerTrigger` registers no component, so its entries are kept apart
 * from the component entries outlets render. Every registration comes back as a
 * disposer; the loader holds the disposers of one load and runs them all when
 * the plugin unloads.
 */
import {
  PLUGIN_SLOT_POSITIONS,
  blockRendererLanguageKey,
  composerTriggerKey,
  pluginToolName,
  slotRegistrationRefusal,
  type PluginComponentSlot,
  type PluginComposerTrigger,
  type PluginComposerTriggerRegistration,
  type PluginDisposer,
  type PluginSlotPosition,
  type PluginSlotRegistration,
} from "@pi-desktop/plugin-sdk";
import { PluginRendererError } from "../renderer-error";

export type SlotEntry = {
  readonly id: string;
  readonly pluginId: string;
  readonly slot: PluginComponentSlot;
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

/** A `composerTrigger` registration: the symbol it owns and its provider. */
export type TriggerEntry = {
  readonly id: string;
  readonly pluginId: string;
  readonly trigger: PluginComposerTrigger;
  readonly items: PluginComposerTriggerRegistration["items"];
};

export type SlotRegistrySnapshot = {
  /** Bumped on every mutation; the `useSyncExternalStore` change signal. */
  readonly version: number;
  /** Registration order across plugins is the presentation order. */
  readonly entries: readonly SlotEntry[];
  /** At most one per symbol. */
  readonly triggers: readonly TriggerEntry[];
};

type ComponentRegistration = Exclude<PluginSlotRegistration, PluginComposerTriggerRegistration>;

function sidesOf(registration: ComponentRegistration): readonly PluginSlotPosition[] {
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
  registration: ComponentRegistration,
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
  private state: SlotRegistrySnapshot = { version: 0, entries: [], triggers: [] };
  private readonly listeners = new Set<() => void>();
  private lastId = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SlotRegistrySnapshot => this.state;

  private commit(next: Partial<Omit<SlotRegistrySnapshot, "version">>): void {
    this.state = { ...this.state, ...next, version: this.state.version + 1 };
    for (const listener of this.listeners) listener();
  }

  private duplicate(slot: string, key: string, holder: { pluginId: string }): PluginRendererError {
    return new PluginRendererError(
      "PLUGIN_SLOT_DUPLICATE",
      `${slot} ${JSON.stringify(key)} is already registered by ${holder.pluginId}`,
    );
  }

  /** A disposer that runs `remove` once. */
  private disposer(remove: () => void): PluginDisposer {
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      remove();
    };
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
    if (accepted.slot === "composerTrigger") return this.registerTrigger(pluginId, accepted);
    const keyed = keyOf(pluginId, accepted);
    if (keyed.key !== undefined) {
      const holder = this.state.entries.find(
        (entry) => entry.slot === accepted.slot && entry.key === keyed.key,
      );
      if (holder) throw this.duplicate(accepted.slot, keyed.key, holder);
    }
    const entry: SlotEntry = {
      id: `slot-${++this.lastId}`,
      pluginId,
      slot: accepted.slot,
      component: accepted.component as SlotEntry["component"],
      sides: sidesOf(accepted),
      ...keyed,
    };
    this.commit({ entries: [...this.state.entries, entry] });
    return this.disposer(() =>
      this.commit({ entries: this.state.entries.filter((candidate) => candidate !== entry) }),
    );
  }

  private registerTrigger(
    pluginId: string,
    registration: PluginComposerTriggerRegistration,
  ): PluginDisposer {
    // The refusal check has already accepted the symbol.
    const trigger = composerTriggerKey(registration.trigger) as PluginComposerTrigger;
    const holder = this.triggerFor(trigger);
    if (holder) throw this.duplicate(registration.slot, trigger, holder);
    const entry: TriggerEntry = {
      id: `slot-${++this.lastId}`,
      pluginId,
      trigger,
      items: registration.items,
    };
    this.commit({ triggers: [...this.state.triggers, entry] });
    return this.disposer(() =>
      this.commit({ triggers: this.state.triggers.filter((candidate) => candidate !== entry) }),
    );
  }

  /** Every registration of a slot, in registration order. */
  entriesFor(slot: PluginComponentSlot): SlotEntry[] {
    return this.state.entries.filter((entry) => entry.slot === slot);
  }

  /** A positioned slot's registrations on one side, in registration order. */
  entriesForSide(slot: PluginComponentSlot, side: PluginSlotPosition): SlotEntry[] {
    return this.state.entries.filter(
      (entry) => entry.slot === slot && entry.sides.includes(side),
    );
  }

  /** The one registration holding a key: a tool's card, a language's renderer. */
  entryForKey(slot: PluginComponentSlot, key: string): SlotEntry | undefined {
    return this.state.entries.find((entry) => entry.slot === slot && entry.key === key);
  }

  /** The plugin owning a composer symbol, if any. */
  triggerFor(trigger: PluginComposerTrigger): TriggerEntry | undefined {
    return this.state.triggers.find((entry) => entry.trigger === trigger);
  }
}

/** The app-wide registry the loader registers into and outlets read from. */
export const slotRegistry = new SlotRegistry();
