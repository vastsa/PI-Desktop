/**
 * Owner-scoped blob access for managed (plugin-owned) transcripts.
 *
 * A managed room message carries attachment *descriptors* (`attachments/<sha256>`
 * plus name/kind/mime/size), never bytes. The owning plugin needs the bytes for
 * two reasons: to ship them to the other computers in the room, and to land the
 * bytes another computer sent. Both directions go through this store, which is
 * deliberately narrow:
 *
 * - a ref must match `attachments/<64 hex>` — a plugin can never name an
 *   arbitrary path, so this cannot be used to read or write user files;
 * - every read and write is scoped to `<dataDir>/attachments`, the same
 *   content-addressed root the renderer already reads images from;
 * - an upload is owned by the plugin that began it, and staged in a private
 *   temp file until `commit` hashes it into place.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A single attachment may not exceed this; the room wire chunks well below it. */
export const MAX_MANAGED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** Base64 payload of one read/write call. */
export const MAX_MANAGED_ATTACHMENT_CHUNK_BASE64 = 1024 * 1024;
/** Staged-but-uncommitted uploads a plugin may hold at once. */
const MAX_PENDING_UPLOADS_PER_PLUGIN = 8;
/** Staged uploads are abandoned after this; the plugin is expected to retry. */
const UPLOAD_IDLE_MS = 10 * 60 * 1000;

const MANAGED_ATTACHMENT_REF = /^attachments\/[0-9a-f]{64}$/i;

export function isManagedAttachmentRef(value: unknown): value is string {
  return typeof value === "string" && MANAGED_ATTACHMENT_REF.test(value.trim());
}

type PendingUpload = {
  pluginId: string;
  path: string;
  expected: number;
  received: number;
  touchedAt: number;
};

function refuse(code: "INVALID_PARAMS" | "LIMIT_EXCEEDED" | "NOT_FOUND", message: string): never {
  throw Object.assign(new Error(message), { errorCode: code });
}

export type ManagedAttachmentStore = ReturnType<typeof createManagedAttachmentStore>;

export function createManagedAttachmentStore(dataDir: string) {
  const root = join(dataDir, "attachments");
  const stagingRoot = join(root, ".uploads");
  const pending = new Map<string, PendingUpload>();

  const blobPath = (ref: string): string => {
    if (!isManagedAttachmentRef(ref)) {
      refuse("INVALID_PARAMS", "attachment ref must be attachments/<sha256>");
    }
    return join(root, (ref as string).trim().slice("attachments/".length).toLowerCase());
  };

  const integer = (value: unknown, field: string, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      refuse("INVALID_PARAMS", `${field} is out of range`);
    }
    return value as number;
  };

  const sweep = (now: number) => {
    for (const [id, upload] of pending) {
      if (now - upload.touchedAt <= UPLOAD_IDLE_MS) continue;
      pending.delete(id);
      rmSync(upload.path, { force: true });
    }
  };

  const staged = (pluginId: string, uploadId: unknown): PendingUpload => {
    const id = typeof uploadId === "string" ? uploadId : "";
    const upload = pending.get(id);
    if (!upload || upload.pluginId !== pluginId) {
      refuse("NOT_FOUND", "attachment upload is not staged");
    }
    return upload as PendingUpload;
  };

  return {
    /** Read one chunk of a stored blob. `eof` marks the final chunk. */
    async read(input: Record<string, unknown>) {
      const ref = input.ref;
      if (!isManagedAttachmentRef(ref)) {
        refuse("INVALID_PARAMS", "attachment ref must be attachments/<sha256>");
      }
      const path = blobPath(ref as string);
      const info = existsSync(path) ? statSync(path) : undefined;
      if (!info || !info.isFile()) {
        refuse("NOT_FOUND", "attachment blob is not stored on this machine");
      }
      const size = (info as { size: number }).size;
      const offset = integer(input.offset ?? 0, "offset", 0, MAX_MANAGED_ATTACHMENT_BYTES);
      const length = integer(
        input.length ?? MAX_MANAGED_ATTACHMENT_CHUNK_BASE64,
        "length",
        1,
        MAX_MANAGED_ATTACHMENT_CHUNK_BASE64,
      );
      const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      if (bytes.length) {
        const handle = await open(path, "r");
        try {
          await handle.read(bytes, 0, bytes.length, offset);
        } finally {
          await handle.close();
        }
      }
      return {
        ref,
        size,
        offset,
        eof: offset + bytes.length >= size,
        contentBase64: bytes.toString("base64"),
      };
    },

    /** Stage a new upload; the bytes arrive in `write` calls. */
    begin(pluginId: string, input: Record<string, unknown>) {
      const now = Date.now();
      sweep(now);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || [...name].length > 255) refuse("INVALID_PARAMS", "attachment name is invalid");
      const size = integer(input.size, "size", 0, MAX_MANAGED_ATTACHMENT_BYTES);
      const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim() : "";
      if ([...mimeType].length > 128) refuse("INVALID_PARAMS", "attachment mimeType is too long");
      const mine = [...pending.values()].filter((upload) => upload.pluginId === pluginId);
      if (mine.length >= MAX_PENDING_UPLOADS_PER_PLUGIN) {
        refuse("LIMIT_EXCEEDED", "too many staged attachments");
      }
      mkdirSync(stagingRoot, { recursive: true });
      const uploadId = randomUUID();
      const path = join(stagingRoot, uploadId);
      pending.set(uploadId, { pluginId, path, expected: size, received: 0, touchedAt: now });
      return { uploadId };
    },

    /** Append one chunk at an exact offset; offsets must arrive in order. */
    async write(pluginId: string, input: Record<string, unknown>) {
      const upload = staged(pluginId, input.uploadId);
      const offset = integer(input.offset, "offset", 0, MAX_MANAGED_ATTACHMENT_BYTES);
      const data = input.dataBase64;
      if (typeof data !== "string" || !data) refuse("INVALID_PARAMS", "dataBase64 is required");
      if ((data as string).length > MAX_MANAGED_ATTACHMENT_CHUNK_BASE64 * 2) {
        refuse("LIMIT_EXCEEDED", "attachment chunk is too large");
      }
      const bytes = Buffer.from(data as string, "base64");
      if (offset !== upload.received) refuse("INVALID_PARAMS", "attachment chunk offset is out of order");
      if (upload.received + bytes.length > upload.expected) {
        refuse("LIMIT_EXCEEDED", "attachment exceeds its declared size");
      }
      await writeFile(upload.path, bytes, { flag: offset === 0 ? "w" : "a" });
      upload.received += bytes.length;
      upload.touchedAt = Date.now();
      return { received: upload.received };
    },

    /** Hash the staged bytes into the content-addressed root. */
    async commit(pluginId: string, input: Record<string, unknown>) {
      const upload = staged(pluginId, input.uploadId);
      pending.delete(input.uploadId as string);
      try {
        if (upload.received !== upload.expected) {
          refuse("INVALID_PARAMS", "attachment upload is incomplete");
        }
        const bytes = await readFile(upload.path);
        const hash = createHash("sha256").update(bytes).digest("hex");
        mkdirSync(root, { recursive: true });
        const target = join(root, hash);
        if (!existsSync(target)) {
          try {
            await rename(upload.path, target);
          } catch {
            // A cross-device rename (or a concurrent identical commit) falls
            // back to a plain copy into the content-addressed name.
            try {
              await writeFile(target, bytes, { flag: "wx" });
            } catch (error) {
              if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
            }
            await rm(upload.path, { force: true });
          }
        } else {
          await rm(upload.path, { force: true });
        }
        return { ref: `attachments/${hash}`, size: bytes.length };
      } catch (error) {
        await rm(upload.path, { force: true });
        throw error;
      }
    },

    /** Drop every staged upload of a plugin (unload / disable). */
    discardPlugin(pluginId: string) {
      for (const [id, upload] of pending) {
        if (upload.pluginId !== pluginId) continue;
        pending.delete(id);
        rmSync(upload.path, { force: true });
      }
    },
  };
}
