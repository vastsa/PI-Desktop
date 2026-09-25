/**
 * Renderer extension contract (`docs/plugin-plan/slot-contract.html`).
 *
 * A plugin holding `renderer.extension` ships a renderer entry
 * (`manifest.renderer`): an ES module the host evaluates in its own window.
 * `onLoad(pi)` registers slot components with `pi.slots.register`, styles with
 * `pi.ui.injectStyle`, and reaches the host only through `pi.dispatch` and the
 * action vocabulary below. Every registration returns a disposer, and
 * unloading the plugin disposes all of them.
 *
 * Slots (`docs/plugin-plan/ui/`):
 * - `userAction` / `assistantAction` — additive items left and right of the
 *   host keys on a message's action bar.
 * - `entryExtra` — additive block below an assistant reply.
 * - `toolCard` — the card for calls of one of the plugin's own agent tools.
 * - `blockRenderer` — a fenced code block tagged `<pluginId>:<lang>`.
 * - `composerControl` — additive controls left and right in the composer
 *   toolbar.
 * - `composerTrigger` — the item list behind one of the composer's trigger
 *   symbols; not a component, the host draws the list
 *   (`./renderer-composer.ts`).
 *
 * Self-dialogs are not a slot: a component draws them itself
 * (`docs/plugin-plan/ui/self-dialog/`), into a layer `pi.ui.openLayer` hands
 * it.
 *
 * The module runs in the host's own realm, so none of this is a security
 * boundary. The contract keeps well-behaved plugins apart and out of the
 * host's way; the `renderer.extension` grant is what trusts the code.
 */

import {
  composerTriggerKey,
  type PluginAttachment,
  type PluginAttachmentAddPayload,
  type PluginAttachmentListPayload,
  type PluginAttachmentRef,
  type PluginComposerTriggerRegistration,
  type PluginDraftListener,
  type PluginDraftSnapshot,
  type PluginDraftWriteResult,
  type PluginReadDraftPayload,
  type PluginReplaceDraftPayload,
} from "./renderer-composer.js";

/** Privileged scheme that serves renderer entry modules. */
export const PLUGIN_RENDERER_SCHEME = "plugin-renderer";

/** Every slot the host mounts. */
export const PLUGIN_RENDERER_SLOTS = [
  "userAction",
  "assistantAction",
  "entryExtra",
  "toolCard",
  "blockRenderer",
  "composerControl",
  "composerTrigger",
] as const;

export type PluginRendererSlot = (typeof PLUGIN_RENDERER_SLOTS)[number];

/** Sides of the action bars and of the composer toolbar. */
export const PLUGIN_SLOT_POSITIONS = ["left", "right"] as const;

export type PluginSlotPosition = (typeof PLUGIN_SLOT_POSITIONS)[number];

/** Slots that mount a component; `composerTrigger` hands the host data instead. */
export type PluginComponentSlot = Exclude<PluginRendererSlot, "composerTrigger">;

/** Slots whose registration takes `positions`. */
const POSITIONED_SLOTS: readonly PluginRendererSlot[] = [
  "userAction",
  "assistantAction",
  "composerControl",
];

/** A message as message-anchored slots see it. */
export type PluginSlotMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt?: string;
};

/**
 * `userAction` / `assistantAction` props: the message, its ids, and the side
 * the item is mounted on. No host functions and no other data.
 */
export type PluginActionSlotProps = {
  readonly message: PluginSlotMessage;
  readonly messageId: string;
  readonly sessionId: string;
  readonly position: PluginSlotPosition;
};

/** `entryExtra` props: assistant replies only, so no `position`. */
export type PluginEntryExtraSlotProps = {
  readonly message: PluginSlotMessage & { readonly role: "assistant" };
  readonly messageId: string;
  readonly sessionId: string;
};

export type PluginToolCardStatus = "running" | "success" | "error";

/**
 * `toolCard` props for one call of the plugin's own tool. `toolName` is the
 * bare name the card registered for. A failed call is data (`toolError`),
 * never a throw.
 */
export type PluginToolCardSlotProps = {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolArgs?: unknown;
  readonly toolStatus: PluginToolCardStatus;
  readonly toolResult?: unknown;
  readonly toolError?: unknown;
  readonly durationMs?: number;
  readonly messageId: string;
  readonly sessionId: string;
};

/** `blockRenderer` props: the fence's language tag and its raw text, once. */
export type PluginBlockRendererSlotProps = {
  readonly language: string;
  readonly source: string;
};

/** `composerControl` props: only where the control is mounted. */
export type PluginComposerControlSlotProps = {
  readonly position: PluginSlotPosition;
};

/**
 * A slot component: a React function component, rendered with the React the
 * host shares through its import map (`import React from "react"`).
 */
export type PluginSlotComponent<Props> = (props: Props) => unknown;

/** `userAction` / `assistantAction`: sides to occupy; omitted means both. */
export type PluginActionSlotRegistration = {
  readonly slot: "userAction" | "assistantAction";
  readonly component: PluginSlotComponent<PluginActionSlotProps>;
  readonly positions?: readonly PluginSlotPosition[];
};

export type PluginEntryExtraSlotRegistration = {
  readonly slot: "entryExtra";
  readonly component: PluginSlotComponent<PluginEntryExtraSlotProps>;
};

/** `toolName` is a bare `contributes.agentTools[].name` of this plugin. */
export type PluginToolCardSlotRegistration = {
  readonly slot: "toolCard";
  readonly toolName: string;
  readonly component: PluginSlotComponent<PluginToolCardSlotProps>;
};

/** `language` is `<pluginId>:<lang>`; tags compare case-insensitively. */
export type PluginBlockRendererSlotRegistration = {
  readonly slot: "blockRenderer";
  readonly language: string;
  readonly component: PluginSlotComponent<PluginBlockRendererSlotProps>;
};

/** Sides to occupy; omitted means both. */
export type PluginComposerControlSlotRegistration = {
  readonly slot: "composerControl";
  readonly component: PluginSlotComponent<PluginComposerControlSlotProps>;
  readonly positions?: readonly PluginSlotPosition[];
};

/** What `pi.slots.register` accepts, discriminated by `slot`. */
export type PluginSlotRegistration =
  | PluginActionSlotRegistration
  | PluginEntryExtraSlotRegistration
  | PluginToolCardSlotRegistration
  | PluginBlockRendererSlotRegistration
  | PluginComposerControlSlotRegistration
  | PluginComposerTriggerRegistration;

/**
 * Outbound actions the host implements. A plugin may dispatch only the words
 * it lists in `manifest.rendererActions`; a word outside this vocabulary is
 * refused with `PLUGIN_ACTION_UNKNOWN`, one outside the manifest with
 * `PLUGIN_ACTION_UNDECLARED`.
 */
export const PLUGIN_RENDERER_ACTIONS = [
  "plugin.call",
  "composer.insertText",
  "composer.readDraft",
  "composer.replaceDraft",
  "attachments.add",
  "attachments.list",
  "attachments.remove",
] as const;

export type PluginRendererActionName = (typeof PLUGIN_RENDERER_ACTIONS)[number];

/** `composer.insertText` text ceiling, in UTF-8 bytes. */
export const PLUGIN_INSERT_TEXT_MAX_BYTES = 32 * 1024;

/**
 * `plugin.call`: one JSON answer from this plugin's `onRendererCall`. The
 * host adds the plugin id; a component can only ever call its own plugin.
 */
export type PluginCallPayload = {
  readonly method: string;
  readonly args?: unknown;
};

/**
 * `composer.insertText`: plain text at the composer caret, replacing the
 * selection. It never triggers a list and never carries a mark.
 */
export type PluginInsertTextPayload = {
  readonly text: string;
};

/** Payload and result of every action word. */
export type PluginRendererActionMap = {
  "plugin.call": { payload: PluginCallPayload; result: unknown };
  "composer.insertText": { payload: PluginInsertTextPayload; result: PluginDraftWriteResult };
  "composer.readDraft": { payload: PluginReadDraftPayload; result: PluginDraftSnapshot };
  "composer.replaceDraft": { payload: PluginReplaceDraftPayload; result: PluginDraftWriteResult };
  "attachments.add": { payload: PluginAttachmentAddPayload; result: PluginAttachmentRef };
  "attachments.list": {
    payload: PluginAttachmentListPayload;
    result: readonly PluginAttachment[];
  };
  "attachments.remove": { payload: PluginAttachmentRef; result: { ok: true } };
};

/**
 * The only outbound channel of renderer code. Rejects with an `Error` whose
 * `code` is a `PluginRendererErrorCode`, or the code the plugin's own
 * `onRendererCall` threw with.
 */
export type PluginRendererDispatch = <Action extends PluginRendererActionName>(
  action: Action,
  payload: PluginRendererActionMap[Action]["payload"],
) => Promise<PluginRendererActionMap[Action]["result"]>;

/** Undoes one registration; calling it again does nothing. */
export type PluginDisposer = () => void;

/**
 * A self-drawn layer (`docs/plugin-plan/ui/self-dialog/`): a host element
 * above the app for a modal dialog or a corner notice, which the plugin fills
 * through `createPortal` and draws with `position: fixed`.
 *
 * Layers stack in the order they opened, the latest on top, within the band
 * reserved for plugins (z 600..899): above the app and its dialogs, below the
 * host's tooltips and window chrome. While the host waits on the user's own
 * decision (a permission request, a question, a plan approval, an extension
 * prompt) every layer is hidden and inert, and comes back unchanged after.
 * The host never closes a layer on Escape; closing is the plugin's own ✕.
 */
export type PluginLayer = {
  /**
   * The portal target. It carries the plugin's style scope, so the plugin's
   * injected sheets apply inside it. It has no size of its own.
   */
  readonly element: HTMLElement;
  /** Removes the layer; calling it again does nothing. */
  readonly close: PluginDisposer;
};

/** The `pi` object handed to a renderer entry's `onLoad`. */
export type PiRendererApi = {
  readonly plugin: {
    readonly id: string;
    readonly version: string;
  };
  readonly slots: {
    /**
     * Mount a component in a slot. Throws an `Error` whose `code` is a
     * `PluginSlotErrorCode` when the host refuses the registration, or
     * `PLUGIN_UNLOADED` once this load has ended.
     */
    register(registration: PluginSlotRegistration): PluginDisposer;
  };
  readonly ui: {
    /**
     * Add a style sheet that applies only inside this plugin's own slot
     * mounts. Style rules are scoped, also inside `@media`, `@supports`,
     * `@container` and `@layer` blocks; rules that define names
     * (`@keyframes`, `@font-face`, `@property`) stay global, and `@import` is
     * dropped. Throws a `TypeError` for anything but a string, and
     * `PLUGIN_UNLOADED` once this load has ended.
     */
    injectStyle(css: string): PluginDisposer;
    /**
     * Open a layer on top of every open one. The end of this load closes
     * whatever it left open. Throws `PLUGIN_UNLOADED` once this load has
     * ended.
     */
    openLayer(): PluginLayer;
  };
  readonly composer: {
    /**
     * Follow the draft instead of polling it: `listener` gets the snapshot
     * now and after every change (as `composer.readDraft` would answer it),
     * and `null` while no composer takes input. Requires `composer.readDraft`
     * in `manifest.rendererActions`, else throws `PLUGIN_ACTION_UNDECLARED`;
     * throws `PLUGIN_UNLOADED` once this load has ended, which also ends the
     * subscription. A throwing listener is logged and stays subscribed.
     */
    subscribeDraft(listener: PluginDraftListener): PluginDisposer;
  };
  readonly dispatch: PluginRendererDispatch;
};

/** Renderer entry module shape: a plain ES module, no build step required. */
export type PiRendererModule = {
  onLoad(pi: PiRendererApi): void | Promise<void>;
  onUnload?(): void | Promise<void>;
};

/** Why `pi.slots.register` refused a registration. */
export type PluginSlotErrorCode =
  /** `slot` is not in `PLUGIN_RENDERER_SLOTS`. */
  | "PLUGIN_SLOT_UNKNOWN"
  /** `component` (or a trigger's `items`) is not a function. */
  | "PLUGIN_SLOT_INVALID_COMPONENT"
  /** A keyed slot's `toolName` / `language` / `trigger` is malformed. */
  | "PLUGIN_SLOT_INVALID_KEY"
  /** `positions` is malformed, or given to a slot without sides. */
  | "PLUGIN_SLOT_INVALID_POSITION"
  /** The key is already registered; the first registration keeps it. */
  | "PLUGIN_SLOT_DUPLICATE"
  /** `toolName` is not one of the plugin's own agent tools. */
  | "PLUGIN_SLOT_NOT_OWNED";

/**
 * Every code the host hands renderer code: the registration refusals above
 * and what `pi.dispatch` rejects with.
 */
export type PluginRendererErrorCode =
  | PluginSlotErrorCode
  /** The word is not in `PLUGIN_RENDERER_ACTIONS`. */
  | "PLUGIN_ACTION_UNKNOWN"
  /** The word is not in `manifest.rendererActions`. */
  | "PLUGIN_ACTION_UNDECLARED"
  /** The payload does not have the word's shape or exceeds its limit. */
  | "PLUGIN_ACTION_INVALID_PAYLOAD"
  /** No composer takes input now: none is mounted, or it is blocked. */
  | "PLUGIN_ACTION_NO_COMPOSER"
  /** `composer.replaceDraft`: `expectedGeneration` is not the current one. */
  | "PLUGIN_DRAFT_STALE"
  /** `composer.replaceDraft`: the composer has focus; the user is typing. */
  | "PLUGIN_DRAFT_FOCUSED"
  /** `composer.replaceDraft`: not called inside a user's input event. */
  | "PLUGIN_DRAFT_REMOTE"
  /** `composer.replaceDraft`: the replacement drops a host chip. */
  | "PLUGIN_DRAFT_ANCHOR"
  /** `attachments.add`: the content is a path or URL, not the file. */
  | "PLUGIN_ATTACHMENT_REFERENCE_REFUSED"
  /** `attachments.add`: over the size ceiling or this plugin's count. */
  | "PLUGIN_ATTACHMENT_LIMIT"
  /** `attachments.add`: no session takes it (home), or the session changed meanwhile. */
  | "PLUGIN_ATTACHMENT_NO_SESSION"
  /** `attachments.remove`: no attachment of this plugin has that id. */
  | "PLUGIN_ATTACHMENT_NOT_FOUND"
  /** `attachments.add`: the host could not stage the file. */
  | "PLUGIN_ATTACHMENT_FAILED"
  /** This load has ended: nothing registers, injects or dispatches through it. */
  | "PLUGIN_UNLOADED"
  /** `plugin.call`: the method is not declared, or `onRendererCall` is missing. */
  | "PLUGIN_CALL_NO_HANDLER"
  /** `plugin.call`: args or answer are not JSON. */
  | "PLUGIN_CALL_UNSERIALIZABLE"
  /** `plugin.call`: no answer within 2s. */
  | "PLUGIN_CALL_TIMEOUT"
  /** `plugin.call`: args and answer exceed 64KB together. */
  | "PLUGIN_CALL_TOO_LARGE"
  /** `plugin.call`: more than 10 calls in one second. */
  | "PLUGIN_CALL_RATE_LIMITED"
  /** `plugin.call`: closed for 30s after five failures in a row. */
  | "PLUGIN_CALL_DISABLED"
  /** `plugin.call`: `onRendererCall` threw without a code of its own. */
  | "PLUGIN_CALL_FAILED";

export type PluginSlotRefusal = {
  readonly code: PluginSlotErrorCode;
  readonly message: string;
};

/**
 * The comparison form of a block-renderer language tag, shared by the
 * registration and the fence lookup.
 */
export function blockRendererLanguageKey(language: string): string {
  return language.trim().toLowerCase();
}

const BLOCK_RENDERER_LANGUAGE_SUFFIX = /^[a-z0-9_-]+$/;

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

function refusal(code: PluginSlotErrorCode, message: string): PluginSlotRefusal {
  return { code, message };
}

/**
 * Check a registration the way the host does before accepting it. Only a clash
 * with an earlier registration (`PLUGIN_SLOT_DUPLICATE`) is left to the host,
 * which alone sees the other plugins. `ownTools` is the plugin's own
 * `contributes.agentTools[].name` list.
 */
export function slotRegistrationRefusal(
  pluginId: string,
  registration: unknown,
  ownTools: readonly string[],
): PluginSlotRefusal | null {
  if (!registration || typeof registration !== "object") {
    return refusal("PLUGIN_SLOT_UNKNOWN", "a registration must be an object naming its slot");
  }
  const candidate = registration as Record<string, unknown>;
  const slot = candidate.slot;
  if (typeof slot !== "string" || !(PLUGIN_RENDERER_SLOTS as readonly string[]).includes(slot)) {
    return refusal("PLUGIN_SLOT_UNKNOWN", `unknown slot ${describe(slot)}`);
  }
  if (slot === "composerTrigger") return composerTriggerRefusal(candidate);
  if (typeof candidate.component !== "function") {
    return refusal("PLUGIN_SLOT_INVALID_COMPONENT", `${slot} component must be a function`);
  }
  const positions = candidate.positions;
  if (positions !== undefined) {
    if (!(POSITIONED_SLOTS as readonly string[]).includes(slot)) {
      return refusal("PLUGIN_SLOT_INVALID_POSITION", `${slot} takes no positions`);
    }
    if (
      !Array.isArray(positions) ||
      positions.length === 0 ||
      positions.some((side) => side !== "left" && side !== "right")
    ) {
      return refusal(
        "PLUGIN_SLOT_INVALID_POSITION",
        `${slot} positions must be a non-empty array of "left" and "right"`,
      );
    }
  }
  if (slot === "toolCard") {
    const toolName = candidate.toolName;
    if (typeof toolName !== "string" || !toolName.trim()) {
      return refusal("PLUGIN_SLOT_INVALID_KEY", "toolCard requires a toolName");
    }
    if (!ownTools.includes(toolName)) {
      return refusal(
        "PLUGIN_SLOT_NOT_OWNED",
        `toolCard toolName ${describe(toolName)} is not one of this plugin's contributes.agentTools`,
      );
    }
  }
  if (slot === "blockRenderer") {
    const language = candidate.language;
    if (typeof language !== "string") {
      return refusal("PLUGIN_SLOT_INVALID_KEY", "blockRenderer requires a language");
    }
    const key = blockRendererLanguageKey(language);
    const prefix = `${pluginId}:`;
    if (!key.startsWith(prefix) || !BLOCK_RENDERER_LANGUAGE_SUFFIX.test(key.slice(prefix.length))) {
      return refusal(
        "PLUGIN_SLOT_INVALID_KEY",
        `blockRenderer language must be "${prefix}<lang>" with <lang> in [A-Za-z0-9_-] (got ${describe(language)})`,
      );
    }
  }
  return null;
}

function composerTriggerRefusal(candidate: Record<string, unknown>): PluginSlotRefusal | null {
  if (typeof candidate.items !== "function") {
    return refusal("PLUGIN_SLOT_INVALID_COMPONENT", "composerTrigger items must be a function");
  }
  if (candidate.positions !== undefined) {
    return refusal("PLUGIN_SLOT_INVALID_POSITION", "composerTrigger takes no positions");
  }
  if (!composerTriggerKey(candidate.trigger)) {
    return refusal(
      "PLUGIN_SLOT_INVALID_KEY",
      `composerTrigger trigger must be "@", "#" or "/" (got ${describe(candidate.trigger)})`,
    );
  }
  return null;
}
