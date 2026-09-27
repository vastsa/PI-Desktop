import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import type {
  ComposerPasteFile,
  ComposerPastedFile,
} from "@pi-desktop/shared";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const MIME_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/plain": ".txt",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
};

const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXTENSIONS).map(([mimeType, extension]) => [extension, mimeType]),
);

Object.assign(MIME_BY_EXTENSION, {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
});

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isImageFile(name: string, mimeType: string): boolean {
  if (isImageMimeType(mimeType)) return true;
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("clipboard file data is invalid");
}

function fileNameOf(name: unknown, mimeType: string, index: number): string {
  const normalized = typeof name === "string" ? name.replaceAll("\\", "/") : "";
  const leaf = basename(normalized)
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+$/, "");
  const fallback = `pasted-file-${index + 1}`;
  const candidate = leaf || fallback;
  const extension = MIME_EXTENSIONS[mimeType] ?? ".bin";
  return extname(candidate) ? candidate : `${candidate}${extension}`;
}

function mimeTypeForPath(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function scratchPasteRoot(dataDir: string, sessionId: string): string {
  return join(dataDir, "scratch", sessionId, "pasted");
}

function pastedOutputPath(root: string, name: string): string {
  return join(root, `pasted-${randomUUID()}-${name}`);
}

/**
 * Materialize renderer clipboard bytes in the session scratch directory.
 * Names are reduced to leaf names and every output receives a unique prefix,
 * so renderer-provided metadata cannot escape or overwrite another paste.
 */
export async function saveComposerPasteFiles(
  dataDir: string,
  sessionId: string,
  files: ComposerPasteFile[],
): Promise<ComposerPastedFile[]> {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error("invalid session id");
  }
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > MAX_FILES) {
    throw new Error(`too many pasted files (maximum ${MAX_FILES})`);
  }

  let totalBytes = 0;
  const prepared = files.map((file, index) => {
    if (!file || typeof file !== "object") {
      throw new Error("clipboard file is invalid");
    }
    const bytes = bytesOf(file.data);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`pasted file is too large (maximum ${MAX_FILE_BYTES} bytes)`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`pasted files are too large (maximum ${MAX_TOTAL_BYTES} bytes)`);
    }
    const mimeType =
      typeof file.mimeType === "string" && file.mimeType.trim()
        ? file.mimeType.trim().toLowerCase()
        : "application/octet-stream";
    return {
      bytes,
      mimeType,
      name: fileNameOf(file.name, mimeType, index),
    };
  });

  const root = scratchPasteRoot(dataDir, sessionId);
  await mkdir(root, { recursive: true });
  return Promise.all(
    prepared.map(async ({ bytes, mimeType, name }) => {
      const path = pastedOutputPath(root, name);
      await writeFile(path, bytes, { flag: "wx" });
      return {
        path,
        name,
        kind: isImageFile(name, mimeType) ? "image" : "file",
        mimeType,
        size: bytes.byteLength,
      };
    }),
  );
}

/**
 * Copy native-picker selections into the owning session scratch directory.
 * The renderer only receives the resulting safe paths; source paths never
 * become prompt references, so arbitrary files remain inside the attachment
 * roots enforced by the main-process prompt boundary.
 */
export async function importComposerFiles(
  dataDir: string,
  sessionId: string,
  paths: string[],
): Promise<ComposerPastedFile[]> {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error("invalid session id");
  }
  if (!Array.isArray(paths) || paths.length === 0) return [];
  if (paths.length > MAX_FILES) {
    throw new Error(`too many imported files (maximum ${MAX_FILES})`);
  }

  const prepared: Array<{
    source: string;
    name: string;
    mimeType: string;
    size: number;
  }> = [];
  let totalBytes = 0;
  for (const [index, rawPath] of paths.entries()) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      throw new Error("import file path is invalid");
    }
    const requested = rawPath.trim();
    if (!isAbsolute(requested)) {
      throw new Error("import file path must be absolute");
    }
    let source: string;
    try {
      source = await realpath(requested);
    } catch {
      throw new Error("import file was not found");
    }
    let size: number;
    try {
      const info = await stat(source);
      if (!info.isFile()) throw new Error("selected path is not a file");
      size = info.size;
    } catch (error) {
      if (error instanceof Error && error.message === "selected path is not a file") {
        throw error;
      }
      throw new Error("import file could not be read");
    }
    if (size > MAX_FILE_BYTES) {
      throw new Error(`imported file is too large (maximum ${MAX_FILE_BYTES} bytes)`);
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`imported files are too large (maximum ${MAX_TOTAL_BYTES} bytes)`);
    }
    const mimeType = mimeTypeForPath(source);
    prepared.push({
      source,
      mimeType,
      size,
      name: fileNameOf(basename(source), mimeType, index),
    });
  }

  const root = scratchPasteRoot(dataDir, sessionId);
  await mkdir(root, { recursive: true });
  return Promise.all(
    prepared.map(async ({ source, mimeType, size, name }) => {
      const path = pastedOutputPath(root, name);
      await copyFile(source, path, fsConstants.COPYFILE_EXCL);
      return {
        path,
        name,
        kind: isImageFile(name, mimeType) ? "image" : "file",
        mimeType,
        size,
      };
    }),
  );
}
