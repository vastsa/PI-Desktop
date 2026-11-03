import { execFileSync } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type NativeClipboard = {
  availableFormats(): string[];
  readBuffer(format: string): Buffer;
};

const MAX_ITEMS = 20;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Read native file metadata only during an explicit Composer paste. */
export function nativeClipboardPaths(clipboard: NativeClipboard): string[] {
  const formats = clipboard.availableFormats();
  const read = (format: string) => {
    if (!formats.includes(format)) return Buffer.alloc(0);
    const bytes = clipboard.readBuffer(format);
    if (bytes.length > MAX_METADATA_BYTES) throw new Error("clipboard file metadata is too large");
    return bytes;
  };
  let paths: string[] = [];
  const macList = read("NSFilenamesPboardType");
  if (macList.length && process.platform === "darwin") {
    const value: unknown = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: macList, maxBuffer: MAX_METADATA_BYTES,
    }).toString("utf8"));
    if (!Array.isArray(value) || !value.every(path => typeof path === "string")) throw new Error("invalid clipboard file list");
    paths = value;
  } else {
    // DROPFILES contains a 20-byte header followed by a NUL-separated list.
    const drop = read("CF_HDROP");
    if (drop.length) {
      if (drop.length < 20) throw new Error("invalid clipboard file list");
      const offset = drop.readUInt32LE(0);
      if (offset < 20 || offset >= drop.length) throw new Error("invalid clipboard file list");
      paths = drop.subarray(offset).toString(drop.readUInt32LE(16) ? "utf16le" : "latin1").split("\0").filter(Boolean);
    } else {
      const wide = read("FileNameW");
      if (wide.length) paths = wide.toString("utf16le").split("\0").filter(Boolean);
      else {
        const uris = read("text/uri-list").toString("utf8") || read("x-special/gnome-copied-files").toString("utf8") || read("public.file-url").toString("utf8");
        paths = uris.split(/[\r\n\0]+/).filter(line => line.startsWith("file:")).map(uri => fileURLToPath(uri));
      }
    }
  }
  paths = [...new Set(paths)];
  if (paths.length > MAX_ITEMS) throw new Error(`too many pasted items (maximum ${MAX_ITEMS})`);
  if (paths.some(path => !isAbsolute(path) || path.includes("\0"))) throw new Error("invalid clipboard file path");
  return paths;
}

/** Directories stay path references; regular files use the existing picker capability. */
export async function readComposerClipboardDirectories(
  clipboard: NativeClipboard,
  rememberFiles: (paths: string[]) => string,
): Promise<{
  items: Array<{ kind: "directory"; path: string; name: string } | { kind: "file"; name: string }>;
  token: string | null;
} | null> {
  // Capture before yielding so later clipboard changes cannot replace this selection.
  const paths = nativeClipboardPaths(clipboard);
  const entries = await Promise.all(paths.map(async path => {
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory() && !metadata.isFile()) throw new Error("clipboard item is not a file or directory");
    return { path: canonical, name: basename(path) || path, directory: metadata.isDirectory() };
  }));
  if (!entries.some(entry => entry.directory)) return null;
  const files = entries.filter(entry => !entry.directory).map(entry => entry.path);
  return {
    items: entries.map(entry => entry.directory
      ? { kind: "directory", path: entry.path, name: entry.name }
      : { kind: "file", name: entry.name }),
    token: files.length ? rememberFiles(files) : null,
  };
}
