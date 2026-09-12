import {
  fileReferenceLabel,
  formatFileInsert,
} from "@pi-desktop/shared";
import type { ComposerFileReference } from "./model";

export { type ComposerFileReference } from "./model";

let composerFileReferenceSequence = 0;

const CODE_FILE_PATTERN =
  /\.(cjs|css|go|java|js|json|jsx|kt|mjs|php|py|rb|rs|sh|sql|svelte|swift|toml|ts|tsx|vue|ya?ml)$/i;
const ARCHIVE_FILE_PATTERN = /\.(7z|bz2|gz|jar|rar|tar|zip)$/i;
const SHEET_FILE_PATTERN = /\.(csv|ods|xls|xlsx)$/i;
const AUDIO_FILE_PATTERN = /\.(flac|m4a|mp3|ogg|wav)$/i;
const VIDEO_FILE_PATTERN = /\.(avi|mkv|m4v|mov|mp4|webm)$/i;

/** Paste/scratch files keep absolute paths; `@` entries are workspace-relative. */
export function isPersistedScratchReference(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function isImageFilePath(path: string): boolean {
  return /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(path);
}

export function formatDroppedDirectoryPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const formatted = formatFileInsert(normalized, "dir");
  // `formatFileInsert` leaves a spaced directory quote open for interactive
  // @ completion. A completed native drop needs a closed token so mixed drops
  // can separate the directory from the following file chip.
  return /\s/.test(normalized) ? `${formatted}"` : formatted;
}

export function createFileReference(
  path: string,
  preferredName?: string,
  sessionId = "",
  metadata?: {
    kind?: "image" | "file";
    mimeType?: string;
    token?: string;
  },
): ComposerFileReference {
  composerFileReferenceSequence += 1;
  return {
    id: `composer-file-${composerFileReferenceSequence}`,
    sessionId,
    path,
    name: fileReferenceLabel(path, preferredName),
    kind: metadata?.kind ?? (isImageFilePath(path) ? "image" : "file"),
    ...(metadata?.mimeType ? { mimeType: metadata.mimeType } : {}),
    ...(metadata?.token ? { token: metadata.token } : {}),
  };
}

const CHIP_TOKEN_BASE = 0xe000;
const CHIP_TOKEN_END = 0xf8ff;
let chipTokenSequence = 0;

export function nextChipToken(): string {
  const range = CHIP_TOKEN_END - CHIP_TOKEN_BASE + 1;
  chipTokenSequence = (chipTokenSequence + 1) % range;
  return String.fromCodePoint(CHIP_TOKEN_BASE + chipTokenSequence);
}

export function isChipTokenChar(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.codePointAt(0) ?? 0;
  return code >= CHIP_TOKEN_BASE && code <= CHIP_TOKEN_END;
}

function isChipElement(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).classList.contains("composer-chip")
  );
}

/** Rendered length of a node in draft-string characters (chip = 1 char). */
function editorNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").length;
  if (isChipElement(node)) return 1;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as HTMLElement;
    if (element.tagName === "BR") return 1;
    let total = 0;
    for (const child of Array.from(node.childNodes)) total += editorNodeLength(child);
    return total;
  }
  return 0;
}

/** Read the editable's DOM back into the plain draft string. */
export function readEditorValue(el: HTMLElement): string {
  let out = "";
  const walk = (node: Node, blockStart: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (isChipElement(element)) {
      const token = element.dataset.token ?? "";
      out += isChipTokenChar(token) ? token : "";
      return;
    }
    if (element.tagName === "BR") {
      out += "\n";
      return;
    }
    if (
      element !== el &&
      (element.tagName === "DIV" || element.tagName === "P")
    ) {
      // Native undo can reintroduce block wrappers; normalize them back
      // to newline-separated text so the value round-trips.
      if (!blockStart && out.length > 0 && !out.endsWith("\n")) out += "\n";
      for (const child of Array.from(element.childNodes)) walk(child, out.length === 0);
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child, blockStart && out.length === 0);
  };
  for (const child of Array.from(el.childNodes)) walk(child, true);
  return out;
}

/** Map a DOM point inside the editable to a draft-string index. */
export function editorIndexAt(
  el: HTMLElement,
  node: Node,
  offset: number,
): number {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(node, offset);
    const fragment = range.cloneContents();
    let total = 0;
    const walk = (parent: DocumentFragment | HTMLElement): void => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          total += (child.nodeValue ?? "").length;
        } else if (isChipElement(child) || (child as HTMLElement).tagName === "BR") {
          total += 1;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child as HTMLElement);
        }
      }
    };
    walk(fragment);
    return total;
  } catch {
    return 0;
  }
}

/** Ordered [start, end] draft-string indices covered by the selection. */
export function editorSelectionRange(el: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const end = readEditorValue(el).length;
    return { start: end, end };
  }
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
    const end = readEditorValue(el).length;
    return { start: end, end };
  }
  const a = editorIndexAt(el, range.startContainer, range.startOffset);
  const b = editorIndexAt(el, range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Draft-string index → DOM caret point. */
function editorCaretPoint(el: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = target;
  let point: { node: Node; offset: number } | null = null;
  const descend = (parent: Node): boolean => {
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const length = editorNodeLength(child);
      if (child.nodeType === Node.TEXT_NODE) {
        if (point === null && remaining <= length) {
          point = { node: child, offset: remaining };
          return true;
        }
        remaining -= length;
      } else if (isChipElement(child) || (child as HTMLElement).tagName === "BR") {
        if (point === null && remaining <= 1) {
          point = { node: parent, offset: remaining === 0 ? index : index + 1 };
          return true;
        }
        remaining -= 1;
      } else if (child.nodeType === Node.ELEMENT_NODE && descend(child)) {
        return true;
      }
    }
    return false;
  };
  descend(el);
  return point ?? { node: el, offset: el.childNodes.length };
}

export function setEditorCaret(el: HTMLElement, index: number): void {
  const point = editorCaretPoint(el, Math.max(0, index));
  const selection = window.getSelection();
  if (!selection) return;
  const maxOffset =
    point.node.nodeType === Node.TEXT_NODE
      ? (point.node.nodeValue ?? "").length
      : point.node.childNodes.length;
  const range = document.createRange();
  range.setStart(point.node, Math.min(point.offset, maxOffset));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** One glyph per file family on attachment chips, as inline SVG strings. */
const CHIP_ICON_SVG: Record<string, string> = {
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  code: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="M14.5 4 9.5 20"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  sheet:
    '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  audio:
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  video:
    '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function chipIconKey(reference: ComposerFileReference): string {
  const mime = reference.mimeType ?? "";
  if (reference.kind === "image" || mime.startsWith("image/")) return "image";
  const name = reference.name;
  if (CODE_FILE_PATTERN.test(name) || /javascript|typescript|json|python/i.test(mime)) {
    return "code";
  }
  if (ARCHIVE_FILE_PATTERN.test(name) || /zip|compressed|tar$/i.test(mime)) return "archive";
  if (SHEET_FILE_PATTERN.test(name) || /csv|spreadsheet/i.test(mime)) return "sheet";
  if (AUDIO_FILE_PATTERN.test(name) || mime.startsWith("audio/")) return "audio";
  if (VIDEO_FILE_PATTERN.test(name) || mime.startsWith("video/")) return "video";
  return "file";
}

function chipSvg(key: string, size = 13): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CHIP_ICON_SVG[key] ?? CHIP_ICON_SVG.file}</svg>`;
}

/** Build the atomic inline chip element for one attachment reference. */
function buildChipElement(
  reference: ComposerFileReference,
  token: string,
  removeLabel: string,
  onRemove: (token: string) => void,
): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "composer-chip";
  chip.contentEditable = "false";
  chip.dataset.token = token;
  chip.title = reference.path;
  chip.setAttribute("role", "listitem");
  chip.setAttribute("aria-label", `${reference.name} — ${reference.path}`);

  const icon = document.createElement("span");
  icon.className = "composer-chip-icon";
  icon.innerHTML = chipSvg(chipIconKey(reference));

  const nameSpan = document.createElement("span");
  nameSpan.className = "composer-chip-name";
  nameSpan.textContent = reference.name;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "composer-chip-remove";
  remove.title = removeLabel;
  remove.setAttribute("aria-label", removeLabel);
  remove.innerHTML = chipSvg("x", 11);
  // Swallow the mousedown so removing a chip never moves the editable caret.
  remove.addEventListener("mousedown", (event) => event.preventDefault());
  remove.addEventListener("click", () => onRemove(token));

  chip.append(icon, nameSpan, remove);
  return chip;
}

/** Paint the contenteditable from the draft string. */
export function paintEditorValue(
  el: HTMLElement,
  value: string,
  referenceByToken: Map<string, ComposerFileReference>,
  removeLabelFor: (name: string) => string,
  onRemove: (token: string) => void,
): void {
  el.replaceChildren();
  let textBuffer = "";
  const flush = () => {
    if (textBuffer) {
      el.appendChild(document.createTextNode(textBuffer));
      textBuffer = "";
    }
  };
  for (const char of Array.from(value)) {
    if (isChipTokenChar(char)) {
      const reference = referenceByToken.get(char);
      if (reference) {
        flush();
        el.appendChild(
          buildChipElement(
            reference,
            char,
            removeLabelFor(reference.name),
            onRemove,
          ),
        );
        continue;
      }
      // A private-use code point with no chip behind it is user text (for
      // example a Nerd Font glyph pasted from a terminal); keep it verbatim.
    }
    textBuffer += char;
  }
  flush();
  if (el.childNodes.length === 0) {
    // Chromium needs at least one node for reliable caret placement.
    el.appendChild(document.createTextNode(""));
  }
}

export function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
