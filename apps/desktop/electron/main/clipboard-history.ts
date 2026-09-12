import { createHash } from "node:crypto";

import type { ClipboardHistoryEntry } from "@pi-desktop/plugin-sdk";

export const CLIPBOARD_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const CLIPBOARD_HISTORY_MAX_TEXT_BYTES = 100 * 1024;
export const CLIPBOARD_HISTORY_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const CLIPBOARD_HISTORY_MAX_ENTRIES = 500;
export const CLIPBOARD_HISTORY_MAX_BYTES = 256 * 1024 * 1024;

export type ClipboardCapture =
  | { type: "text"; text: string }
  | {
      type: "image";
      format: "png" | "jpeg" | "webp";
      data: Uint8Array;
      width: number;
      height: number;
    };

type ClipboardHistoryOptions = {
  now?: () => number;
};

type StoredEntry = ClipboardHistoryEntry & { signature: string };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function contentBytes(capture: ClipboardCapture): number {
  return capture.type === "text" ? byteLength(capture.text) : capture.data.byteLength;
}

function signatureFor(capture: ClipboardCapture): string {
  const hash = createHash("sha256");
  hash.update(capture.type);
  if (capture.type === "text") {
    hash.update(capture.text, "utf8");
  } else {
    hash.update(capture.format);
    hash.update(capture.data);
  }
  return hash.digest("hex");
}

function cloneEntry(entry: StoredEntry): ClipboardHistoryEntry {
  if (entry.type === "text") {
    return {
      type: "text",
      text: entry.text,
      capturedAt: entry.capturedAt,
    };
  }
  return {
    type: "image",
    format: entry.format,
    data: entry.data.slice(),
    width: entry.width,
    height: entry.height,
    capturedAt: entry.capturedAt,
  };
}

/**
 * Owns the host's in-memory clipboard history. Entries are added only by
 * explicit host writes or user paste events. In particular, this class never
 * reads the system clipboard or starts a background timer.
 */
export class ClipboardHistory {
  private readonly now: () => number;
  private entries: StoredEntry[] = [];
  private totalBytes = 0;
  private lastSignature: string | null = null;
  private lastRecordedSignature: string | null = null;

  constructor(options: ClipboardHistoryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  recordText(text: string, capturedAt = new Date(this.now()).toISOString()): void {
    this.recordCapture({ type: "text", text }, capturedAt);
  }

  recordImage(
    image: Omit<Extract<ClipboardCapture, { type: "image" }>, "type">,
    capturedAt = new Date(this.now()).toISOString(),
  ): void {
    this.recordCapture({ type: "image", ...image }, capturedAt);
  }

  getHistory(): ClipboardHistoryEntry[] {
    this.prune();
    return this.entries.map(cloneEntry);
  }

  private recordCapture(
    capture: ClipboardCapture,
    capturedAt = new Date(this.now()).toISOString(),
  ): void {
    const signature = signatureFor(capture);
    const repeated = signature === this.lastSignature;
    this.lastSignature = signature;

    if (repeated && this.lastRecordedSignature === signature && this.entries[0]) {
      this.entries[0] = { ...this.entries[0], capturedAt };
      return;
    }

    this.lastRecordedSignature = null;
    const size = contentBytes(capture);
    const maxBytes = capture.type === "text"
      ? CLIPBOARD_HISTORY_MAX_TEXT_BYTES
      : CLIPBOARD_HISTORY_MAX_IMAGE_BYTES;
    if (size === 0 || size > maxBytes) return;

    const entry: StoredEntry = capture.type === "text"
      ? { type: "text", text: capture.text, capturedAt, signature }
      : {
          type: "image",
          format: capture.format,
          data: capture.data.slice(),
          width: capture.width,
          height: capture.height,
          capturedAt,
          signature,
        };
    this.entries.unshift(entry);
    this.totalBytes += size;
    this.lastRecordedSignature = signature;
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - CLIPBOARD_HISTORY_RETENTION_MS;
    this.entries = this.entries.filter((entry) => {
      if (Date.parse(entry.capturedAt) >= cutoff) return true;
      this.totalBytes -= contentBytes(entry);
      return false;
    });

    while (
      this.entries.length > CLIPBOARD_HISTORY_MAX_ENTRIES ||
      this.totalBytes > CLIPBOARD_HISTORY_MAX_BYTES
    ) {
      const removed = this.entries.pop();
      if (!removed) break;
      this.totalBytes -= contentBytes(removed);
    }
    this.totalBytes = Math.max(0, this.totalBytes);
    if (this.lastRecordedSignature && this.entries[0]?.signature !== this.lastRecordedSignature) {
      this.lastRecordedSignature = null;
    }
  }
}
