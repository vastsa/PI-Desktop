/**
 * The composer end of the plugin draft and attachment actions
 * (`docs/plugin-plan/render/draft/`, `docs/plugin-plan/render/attachments/`).
 *
 * A composer taking input registers a handle; the last one registered is the
 * one plugins reach, so a composer that mounts over another takes over until
 * it unmounts. The bridge owns the draft's generation: one counter for the
 * whole window, moved on by every change of the draft the handle shows,
 * including a switch to another session's draft, so `expectedGeneration`
 * compares across switches too.
 *
 * A write reaches the composer's state at once but its DOM only on the next
 * render, so until the composer publishes that render, the bridge reads the
 * draft it wrote instead of the handle's.
 */
import {
  PLUGIN_ATTACHMENTS_MAX,
  type PluginAttachment,
  type PluginDraftListener,
  type PluginDraftSnapshot,
  type PluginDraftWriteResult,
  type PluginRendererErrorCode,
} from "@pi-desktop/plugin-sdk";
import type { ComposerPasteFile, ComposerPastedFile } from "@pi-desktop/shared";
import { PluginRendererError } from "../../../../plugins/renderer-error";
import { createFileReference, nextChipToken } from "../editor";
import type { ComposerFileReference } from "../model";
import {
  draftReferences,
  draftSignature,
  holdsDraftChip,
  planDraftReplacement,
  pluginDraftView,
  type DraftMarkInput,
  type LiveDraft,
} from "./plugin-draft";

/** What a composer lends the bridge while it takes input. */
export type ComposerDraftHandle = {
  /** The draft as the composer holds it, or `null` while input is blocked. */
  read(): LiveDraft | null;
  /** Whether the user is in the composer's input. */
  focused(): boolean;
  /** The selection in the draft text; the end of it when outside. */
  selection(): { start: number; end: number };
  /** Set the draft; `focus` also moves focus into the input. */
  write(text: string, references: ComposerFileReference[], caret: number, focus: boolean): void;
  /** Keep a file in the session's scratch space for the next message. */
  stage(sessionId: string, file: ComposerPasteFile): Promise<ComposerPastedFile>;
};

/** `composer.replaceDraft`, its shape checked. */
export type DraftReplaceInput = {
  readonly expectedGeneration: number;
  readonly text: string;
  readonly marks: readonly DraftMarkInput[];
};

/** `attachments.add`, its shape and limits checked. */
export type AttachmentInput = {
  readonly name: string;
  readonly mimeType: string;
  readonly data: ArrayBuffer;
};

type Live = { readonly handle: ComposerDraftHandle; readonly draft: LiveDraft };
type Subscriber = { readonly pluginId: string; readonly listener: PluginDraftListener };

function refuse(code: PluginRendererErrorCode, message: string): never {
  throw new PluginRendererError(code, message);
}

/** `pluginId`'s attachments in the draft, the detached images included. */
function ownAttachments(draft: LiveDraft, pluginId: string): ComposerFileReference[] {
  return draftReferences(draft).filter(
    (reference) =>
      reference.plugin?.kind === "attachment" &&
      reference.plugin.pluginId === pluginId &&
      (!reference.token || draft.text.includes(reference.token)),
  );
}

export class ComposerDraftBridge {
  private readonly handles: ComposerDraftHandle[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private pending: (Live & { readonly caret: number }) | null = null;
  private signature = "";
  private generation = 0;
  private readonly warn: (message: string, error: unknown) => void;

  constructor(warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error)) {
    this.warn = warn;
  }

  /** Lend the bridge a composer; the returned call takes it back. */
  register(handle: ComposerDraftHandle): () => void {
    this.handles.push(handle);
    this.sync();
    return () => {
      const index = this.handles.lastIndexOf(handle);
      if (index === -1) return;
      this.handles.splice(index, 1);
      if (this.pending?.handle === handle) this.pending = null;
      this.sync();
    };
  }

  /** The composer's word that it rendered a change of its draft. */
  publish(handle: ComposerDraftHandle): void {
    if (this.pending?.handle === handle) this.pending = null;
    this.sync();
  }

  subscribe(pluginId: string, listener: PluginDraftListener): () => void {
    const subscriber: Subscriber = { pluginId, listener };
    const live = this.sync();
    this.subscribers.add(subscriber);
    this.notify(subscriber, live);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  readDraft(pluginId: string): PluginDraftSnapshot {
    return this.snapshot(this.require().draft, pluginId);
  }

  /** Put plain text at the caret, replacing the selection, and focus the input. */
  insertText(text: string): PluginDraftWriteResult {
    const { handle, draft } = this.require();
    if (holdsDraftChip(draft, text)) {
      refuse("PLUGIN_ACTION_INVALID_PAYLOAD", "the text holds a chip token of the draft");
    }
    const pending = this.pending?.handle === handle ? this.pending : null;
    const { start, end } = pending ? { start: pending.caret, end: pending.caret } : handle.selection();
    const next = draft.text.slice(0, start) + text + draft.text.slice(end);
    return this.commit({ handle, draft }, next, [...draft.references], start + text.length, true);
  }

  /**
   * Replace the whole draft. The gates run in this order and a refusal
   * writes nothing: a composer takes input, the call runs in a user's input
   * event, the input does not have focus, the generation is current, the
   * marks are the draft's and keep every host chip.
   */
  replaceDraft(pluginId: string, input: DraftReplaceInput, userGesture: boolean): PluginDraftWriteResult {
    const live = this.require();
    if (!userGesture) {
      refuse("PLUGIN_DRAFT_REMOTE", "composer.replaceDraft runs only inside a user's input event");
    }
    if (live.handle.focused()) {
      refuse("PLUGIN_DRAFT_FOCUSED", "the composer has focus; use composer.insertText");
    }
    if (input.expectedGeneration !== this.generation) {
      refuse("PLUGIN_DRAFT_STALE", `the draft is at generation ${this.generation}`);
    }
    const plan = planDraftReplacement(live.draft, pluginId, input.text, input.marks);
    if ("code" in plan) refuse(plan.code, plan.message);
    return this.commit(live, plan.text, plan.references, plan.text.length, false);
  }

  listAttachments(pluginId: string): PluginAttachment[] {
    return ownAttachments(this.require().draft, pluginId).map((reference) => ({
      id: reference.plugin?.kind === "attachment" ? reference.plugin.id : "",
      name: reference.name,
      mimeType: reference.mimeType ?? "application/octet-stream",
      size: reference.plugin?.kind === "attachment" ? reference.plugin.size : 0,
    }));
  }

  /**
   * Stage `input` for the next message of the session whose draft the
   * composer shows now. An image goes with the draft's images; any other
   * file is a chip at the end of the text. Neither moves focus.
   */
  async addAttachment(pluginId: string, input: AttachmentInput): Promise<{ id: string }> {
    const { handle, draft } = this.require();
    const sessionId = draft.sessionId;
    if (!sessionId) refuse("PLUGIN_ATTACHMENT_NO_SESSION", "home has no session to take a file");
    this.assertRoom(draft, pluginId);
    let staged: ComposerPastedFile;
    try {
      staged = await handle.stage(sessionId, { name: input.name, mimeType: input.mimeType, data: input.data });
    } catch (error) {
      refuse("PLUGIN_ATTACHMENT_FAILED", error instanceof Error ? error.message : String(error));
    }
    const live = this.sync();
    if (!live || live.draft.sessionId !== sessionId) {
      refuse("PLUGIN_ATTACHMENT_NO_SESSION", "the session changed before the file was staged");
    }
    this.assertRoom(live.draft, pluginId);
    const id = crypto.randomUUID();
    const token = staged.kind === "image" ? undefined : nextChipToken();
    const reference = createFileReference(staged.path, staged.name, sessionId, {
      kind: staged.kind,
      mimeType: staged.mimeType,
      token,
      plugin: { kind: "attachment", pluginId, id, size: staged.size },
    });
    const text = live.draft.text + (token ?? "");
    this.commit(live, text, [...live.draft.references, reference], text.length, false);
    return { id };
  }

  removeAttachment(pluginId: string, id: string): { ok: true } {
    const live = this.require();
    const target = ownAttachments(live.draft, pluginId).find(
      (reference) => reference.plugin?.kind === "attachment" && reference.plugin.id === id,
    );
    if (!target) refuse("PLUGIN_ATTACHMENT_NOT_FOUND", `${pluginId} has no attachment ${JSON.stringify(id)}`);
    const text = target.token ? live.draft.text.split(target.token).join("") : live.draft.text;
    const references = live.draft.references.filter((reference) => reference !== target);
    this.commit(live, text, references, text.length, false);
    return { ok: true };
  }

  private assertRoom(draft: LiveDraft, pluginId: string): void {
    if (ownAttachments(draft, pluginId).length >= PLUGIN_ATTACHMENTS_MAX) {
      refuse("PLUGIN_ATTACHMENT_LIMIT", `a plugin holds at most ${PLUGIN_ATTACHMENTS_MAX} attachments`);
    }
  }

  /** The composer plugins reach and its draft, the bridge's own write first. */
  private live(): Live | null {
    const handle = this.handles.at(-1);
    const read = handle?.read() ?? null;
    if (!handle || !read) return null;
    return { handle, draft: this.pending?.handle === handle ? this.pending.draft : read };
  }

  /** Bring the generation up to the live draft and tell subscribers of a change. */
  private sync(): Live | null {
    const live = this.live();
    const signature = draftSignature(live?.draft ?? null);
    if (signature !== this.signature) {
      this.signature = signature;
      this.generation += 1;
      for (const subscriber of [...this.subscribers]) this.notify(subscriber, live);
    }
    return live;
  }

  private require(): Live {
    return this.sync() ?? refuse("PLUGIN_ACTION_NO_COMPOSER", "no composer takes input");
  }

  private commit(
    live: Live,
    text: string,
    references: ComposerFileReference[],
    caret: number,
    focus: boolean,
  ): PluginDraftWriteResult {
    live.handle.write(text, references, caret, focus);
    this.pending = { handle: live.handle, draft: { ...live.draft, text, references }, caret };
    this.sync();
    return { ok: true, generation: this.generation };
  }

  private snapshot(draft: LiveDraft, pluginId: string): PluginDraftSnapshot {
    return { ...pluginDraftView(draft, pluginId), generation: this.generation };
  }

  private notify(subscriber: Subscriber, live: Live | null): void {
    if (!this.subscribers.has(subscriber)) return;
    try {
      subscriber.listener(live ? this.snapshot(live.draft, subscriber.pluginId) : null);
    } catch (error) {
      this.warn(`[plugin-renderer] ${subscriber.pluginId} draft listener failed`, error);
    }
  }
}

/** The app window's bridge. */
export const composerDraftBridge = new ComposerDraftBridge();
