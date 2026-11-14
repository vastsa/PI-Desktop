import { execFile, type ExecFileException } from "node:child_process";
import { basename, join, posix, win32 } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type NativeClipboard = {
  readBuffer(format: string): Buffer;
};

const MAX_ITEMS = 20;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Exported so a regression can exercise a real child process boundary. */
export async function execFileAsync(
  command: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; [key: string]: unknown },
  input?: Buffer,
): Promise<Buffer> {
  // execFile defaults to utf8 strings; pin the buffer encoding so stdout stays binary
  // no matter which caller reads a clipboard, and normalize anything that still
  // arrives as a string instead of throwing inside the stream handler.
  const child = execFile(command, args, { encoding: "buffer", ...options });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    // Stream errors must reject the promise; an unhandled handler would crash Main.
    child.stdout?.on("error", fail);
    child.stdin?.on("error", fail);
    child.on("error", (error: ExecFileException) => {
      fail(new Error(error.message || "clipboard file list read failed"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error("clipboard file list read failed"));
    });
    child.stdin?.end(input);
  });
}

async function windowsClipboardPaths(): Promise<string[]> {
  // CF_HDROP is a built-in format, not the custom format named "CF_HDROP".
  const command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList())";
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const value: unknown = JSON.parse(
    (
      await execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", command], {
        windowsHide: true, timeout: 10000, maxBuffer: MAX_METADATA_BYTES,
      })
    ).toString("utf8"),
  );
  if (!Array.isArray(value) || !value.every(path => typeof path === "string")) throw new Error("invalid clipboard file list");
  return value;
}

/** Read native file metadata only during an explicit Composer paste. */
export async function nativeClipboardPaths(
  clipboard: NativeClipboard,
  platform: NodeJS.Platform = process.platform,
  readWindowsPaths: () => Promise<string[]> = windowsClipboardPaths,
): Promise<string[]> {
  const read = (format: string) => {
    // availableFormats exposes normalized MIME names, not native pasteboard types.
    const bytes = clipboard.readBuffer(format);
    if (bytes.length > MAX_METADATA_BYTES) throw new Error("clipboard file metadata is too large");
    return bytes;
  };
  let paths: string[] = [];
  const macList = platform === "darwin" ? read("NSFilenamesPboardType") : Buffer.alloc(0);
  if (platform === "win32") paths = await readWindowsPaths();
  else if (macList.length) {
    const value: unknown = JSON.parse(
      (
        await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
          maxBuffer: MAX_METADATA_BYTES,
          timeout: 10000,
        }, macList)
      ).toString("utf8"),
    );
    if (!Array.isArray(value) || !value.every(path => typeof path === "string")) throw new Error("invalid clipboard file list");
    paths = value;
  } else {
    const uris = read("text/uri-list").toString("utf8") || read("x-special/gnome-copied-files").toString("utf8") || read("public.file-url").toString("utf8");
    paths = uris.split(/[\r\n\0]+/).filter(line => line.startsWith("file:")).map(uri => fileURLToPath(uri, { windows: false }));
  }
  paths = [...new Set(paths)];
  if (paths.length > MAX_ITEMS) throw new Error(`too many pasted items (maximum ${MAX_ITEMS})`);
  const absolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  if (paths.some(path => !absolute(path) || path.includes("\0"))) throw new Error("invalid clipboard file path");
  return paths;
}

/** Capture native paths without reading file contents. */
export async function readComposerClipboardDirectories(
  clipboard: NativeClipboard,
  rememberFiles: (paths: string[]) => string,
  capturePaths: () => Promise<string[]> = async () => nativeClipboardPaths(clipboard),
): Promise<{
  items: Array<{ kind: "directory"; path: string; name: string } | { kind: "file"; name: string }>;
  token: string | null;
} | null> {
  // Capture before yielding so later clipboard changes cannot replace this selection.
  const paths = await capturePaths();
  const entries = await Promise.all(paths.map(async path => {
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory() && !metadata.isFile()) throw new Error("clipboard item is not a file or directory");
    return { path: canonical, name: basename(path) || path, directory: metadata.isDirectory() };
  }));
  if (!entries.length) return null;
  const files = entries.filter(entry => !entry.directory).map(entry => entry.path);
  return {
    items: entries.map(entry => entry.directory
      ? { kind: "directory", path: entry.path, name: entry.name }
      : { kind: "file", name: entry.name }),
    token: files.length ? rememberFiles(files) : null,
  };
}
