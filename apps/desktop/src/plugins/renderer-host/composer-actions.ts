/**
 * The composer words of `pi.dispatch` (`docs/plugin-plan/render/draft/`,
 * `docs/plugin-plan/render/attachments/`): the payload checks that need no
 * draft, then the draft bridge, which owns everything that does. None of them
 * leaves the renderer.
 */
import {
  PLUGIN_ATTACHMENT_MAX_BYTES,
  PLUGIN_DRAFT_MARK_CHAR,
  PLUGIN_DRAFT_TEXT_MAX_BYTES,
  PLUGIN_INSERT_TEXT_MAX_BYTES,
  type PluginRendererActionName,
  type PluginRendererErrorCode,
} from "@pi-desktop/plugin-sdk";
import type {
  AttachmentInput,
  ComposerDraftBridge,
  DraftReplaceInput,
} from "../../features/chat/composer/plugins/draft-bridge";
import type { DraftMarkInput } from "../../features/chat/composer/plugins/plugin-draft";
import { sanitizeTriggerItem } from "../../features/chat/composer/plugins/plugin-triggers";
import { PluginRendererError } from "../renderer-error";

/** The bridge calls the composer words end in. */
export type ComposerRoutes = Pick<
  ComposerDraftBridge,
  | "insertText"
  | "readDraft"
  | "replaceDraft"
  | "addAttachment"
  | "listAttachments"
  | "removeAttachment"
>;

const utf8 = new TextEncoder();

function refuse(code: PluginRendererErrorCode, message: string): never {
  throw new PluginRendererError(code, message);
}

function invalid(message: string): never {
  refuse("PLUGIN_ACTION_INVALID_PAYLOAD", message);
}

function onlyKeys(payload: Record<string, unknown>, action: string, keys: readonly string[]): void {
  const extra = Object.keys(payload).find((key) => !keys.includes(key));
  if (extra !== undefined) invalid(`${action} takes no ${JSON.stringify(extra)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function insertTextInput(payload: Record<string, unknown>): string {
  const text = payload.text;
  if (
    typeof text !== "string" ||
    !text ||
    utf8.encode(text).byteLength > PLUGIN_INSERT_TEXT_MAX_BYTES
  ) {
    invalid(
      `composer.insertText requires non-empty text of at most ${PLUGIN_INSERT_TEXT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return text;
}

function markInput(mark: unknown, index: number): DraftMarkInput {
  const where = `composer.replaceDraft marks[${index}]`;
  if (!isRecord(mark)) invalid(`${where} must be an object`);
  if ("id" in mark) {
    onlyKeys(mark, where, ["id"]);
    if (typeof mark.id !== "string" || !mark.id) invalid(`${where}.id must be a mark id`);
    return { id: mark.id };
  }
  onlyKeys(mark, where, ["label", "send"]);
  const row = sanitizeTriggerItem(mark);
  if (!row) invalid(`${where} breaks the mark limits (label, send)`);
  return { label: row.label, send: row.send };
}

function replaceDraftInput(payload: Record<string, unknown>): DraftReplaceInput {
  const action = "composer.replaceDraft";
  onlyKeys(payload, action, ["expectedGeneration", "text", "marks"]);
  const { expectedGeneration, text, marks = [] } = payload;
  if (!Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) {
    invalid(`${action} requires the expectedGeneration of a snapshot`);
  }
  if (typeof text !== "string" || utf8.encode(text).byteLength > PLUGIN_DRAFT_TEXT_MAX_BYTES) {
    invalid(`${action} requires text of at most ${PLUGIN_DRAFT_TEXT_MAX_BYTES} UTF-8 bytes`);
  }
  if (!Array.isArray(marks)) invalid(`${action} marks must be an array`);
  const slots = text.split(PLUGIN_DRAFT_MARK_CHAR).length - 1;
  if (slots !== marks.length) {
    invalid(`${action} text has ${slots} mark chars for ${marks.length} marks`);
  }
  return {
    expectedGeneration: expectedGeneration as number,
    text,
    marks: marks.map(markInput),
  };
}

// Control characters and path separators have no place in a file name.
const NAME_FORBIDDEN = /[\u0000-\u001F\u007F/\\]/;
const NAME_EXTENSION = /[^.]\.[A-Za-z0-9]+$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
/**
 * A string that is a single-line path or URL is a reference to content, not
 * content: S1 has the host refuse it rather than read it.
 */
const REFERENCE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:file|data|blob|https?|ftp):|[a-z]:[\\/]|\/|~\/|\.\.?\/|\\\\)/i;

function attachmentInput(payload: Record<string, unknown>): AttachmentInput {
  const action = "attachments.add";
  if ("token" in payload) {
    invalid(`${action} takes the content itself; the token form is reserved`);
  }
  onlyKeys(payload, action, ["name", "mimeType", "content"]);
  const { name, mimeType, content } = payload;
  if (
    typeof name !== "string" ||
    name.length > 255 ||
    NAME_FORBIDDEN.test(name) ||
    !NAME_EXTENSION.test(name)
  ) {
    invalid(`${action} name must be a file name with an extension`);
  }
  if (typeof mimeType !== "string" || !MIME_TYPE.test(mimeType)) {
    invalid(`${action} mimeType must be a type/subtype`);
  }
  let bytes: Uint8Array;
  if (typeof content === "string") {
    const line = content.trim();
    if (!/[\r\n]/.test(line) && REFERENCE.test(line)) {
      refuse(
        "PLUGIN_ATTACHMENT_REFERENCE_REFUSED",
        `${action} takes the file's content, not a path or URL to it`,
      );
    }
    bytes = utf8.encode(content);
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else if (content instanceof Uint8Array) {
    bytes = content;
  } else {
    invalid(`${action} content must be a string, an ArrayBuffer or a Uint8Array`);
  }
  if (bytes.byteLength > PLUGIN_ATTACHMENT_MAX_BYTES) {
    refuse("PLUGIN_ATTACHMENT_LIMIT", `an attachment holds at most ${PLUGIN_ATTACHMENT_MAX_BYTES} bytes`);
  }
  // A copy, so the plugin cannot change the bytes while they are staged.
  const data = bytes.slice().buffer as ArrayBuffer;
  return { name, mimeType, data };
}

/**
 * Run one composer word for `pluginId`. `userGesture` is whether the
 * dispatch started inside a user's input event.
 */
export function runComposerAction(
  pluginId: string,
  action: Exclude<PluginRendererActionName, "plugin.call">,
  payload: Record<string, unknown>,
  routes: ComposerRoutes,
  userGesture: boolean,
): unknown {
  switch (action) {
    case "composer.insertText":
      return routes.insertText(insertTextInput(payload));
    case "composer.readDraft":
      return routes.readDraft(pluginId);
    case "composer.replaceDraft":
      return routes.replaceDraft(pluginId, replaceDraftInput(payload), userGesture);
    case "attachments.add":
      return routes.addAttachment(pluginId, attachmentInput(payload));
    case "attachments.list":
      return routes.listAttachments(pluginId);
    case "attachments.remove": {
      const id = payload.id;
      if (typeof id !== "string" || !id) invalid("attachments.remove requires an attachment id");
      return routes.removeAttachment(pluginId, id);
    }
  }
}

const GESTURE_EVENTS = new Set([
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "keydown",
  "keyup",
  "keypress",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "touchstart",
  "touchend",
  "input",
  "change",
  "submit",
]);

/**
 * Whether code runs inside the handler of a user's own input event: one the
 * browser dispatched (`isTrusted`) of a kind only a person causes. A timer, a
 * network answer or a `plugin.call` reply runs outside any event.
 */
export function isUserGesture(event: Event | undefined = globalThis.window?.event): boolean {
  return event !== undefined && event.isTrusted && GESTURE_EVENTS.has(event.type);
}
