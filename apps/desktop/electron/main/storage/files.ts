import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rm, statfs, symlink, writeFile, readFile, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StorageProgress } from "@pi-desktop/shared";
import { STORAGE_PREFERENCE_FILE, type StorageRoots } from "./preferences";

const OWNER_FILE = ".pi-storage-owner.json";
export const DATA_CACHE_PATHS = ["cache", "plugins/cache/download", "plugins/cache/backup", "openable-attachments"];
const BROWSER_CACHE_PATHS = ["Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache", "GrShaderCache", "GraphiteDawnCache"];
const excluded = (name: string) => name === STORAGE_PREFERENCE_FILE || name.startsWith("Singleton") || /^\.storage-.*\.tmp$/.test(name);
export function contains(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return !part || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}
async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function validateTarget(path: string, source: StorageRoots, anchor: string, retryId?: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Select an absolute directory.");
  const target = await realpath(path);
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error("Select a real directory, not a symbolic link.");
  for (const sourcePath of [source.data, source.browser, anchor]) {
    const canonical = await canonicalPath(sourcePath);
    if (contains(canonical, target) || contains(target, canonical)) throw new Error("The destination must be separate from the current storage directories.");
  }
  const names = await readdir(target);
  if (names.length) {
    if (!retryId) throw new Error("Select an empty destination directory.");
    await assertClaimed(target, retryId, names);
  }
  return target;
}

type Entry = { from: string; to: string; kind: "file" | "directory" | "link"; bytes: number; mode: number; link?: string };
async function inventory(from: string, to: string, entries: Entry[], browser = false): Promise<void> {
  const info = await lstat(from);
  if (info.isSymbolicLink()) {
    entries.push({ from, to, kind: "link", bytes: 0, mode: info.mode, link: await readlink(from) });
  } else if (info.isDirectory()) {
    entries.push({ from, to, kind: "directory", bytes: 0, mode: info.mode });
    for (const name of await readdir(from)) {
      if (browser && excluded(name)) continue;
      await inventory(join(from, name), join(to, name), entries, browser);
    }
  } else if (info.isFile()) {
    entries.push({ from, to, kind: "file", bytes: info.size, mode: info.mode });
  } else {
    throw new Error("Storage contains a special file that cannot be safely migrated.");
  }
}
async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function canonicalPath(path: string): Promise<string> {
  if (await optionalStat(path)) return realpath(path);
  return join(await realpath(dirname(path)), relative(dirname(path), path));
}
async function assertClaimed(target: string, id: string, names: string[]): Promise<void> {
  const owner = join(target, OWNER_FILE);
  if (!(await lstat(owner)).isFile() || (await lstat(owner)).isSymbolicLink()) throw new Error("Invalid migration ownership marker.");
  const marker: unknown = JSON.parse(await readFile(owner, "utf8"));
  if (!marker || typeof marker !== "object" || !("id" in marker) || marker.id !== id
    || names.some((name) => ![OWNER_FILE, "data", "browser"].includes(name))) throw new Error("Destination contains unrelated data; select an empty directory.");
}
function relocatedLink(entry: Entry, mappings: Array<[string, string]>): string {
  const link = entry.link ?? "";
  const absolute = resolve(dirname(entry.from), link);
  for (const [from, to] of mappings) if (contains(from, absolute)) {
    const next = join(to, relative(from, absolute));
    return isAbsolute(link) ? next : relative(dirname(entry.to), next);
  }
  // A relative external link also needs adjustment because its parent moved.
  return isAbsolute(link) ? link : relative(dirname(entry.to), absolute);
}

/** Cold copy only: no database, browser, plugin, or log writer may be running. */
export async function migrateFiles(input: {
  source: StorageRoots; target: string; anchor: string; id: string;
  progress: (value: StorageProgress) => void;
  relocate: (oldRoot: string, newRoot: string) => Promise<void>;
}): Promise<StorageRoots> {
  const { source, anchor, id, progress, relocate } = input;
  const requestedTarget = resolve(input.target);
  const target = await realpath(requestedTarget);
  if (target !== requestedTarget) throw new Error("Destination directory changed identity.");
  const owner = join(target, OWNER_FILE);
  const names = await readdir(target);
  if (names.length) {
    // An interrupted copy can be retried only inside the directory claimed by this exact job.
    await assertClaimed(target, id, names);
    await assertSeparate(target, source, anchor);
    await rm(join(target, "data"), { recursive: true, force: true });
    await rm(join(target, "browser"), { recursive: true, force: true });
  } else {
    await validateTarget(target, source, anchor);
    await writeFile(owner, JSON.stringify({ id }), { flag: "wx", mode: 0o600 });
  }
  const next = { data: join(target, "data"), browser: join(target, "browser") };
  const entries: Entry[] = [];
  const state: StorageProgress = { stage: "scanning", completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
  progress({ ...state });
  if (await optionalStat(source.data)) await inventory(await realpath(source.data), next.data, entries);
  else entries.push({ from: source.data, to: next.data, kind: "directory", bytes: 0, mode: 0o700 });
  await inventory(await realpath(source.browser), next.browser, entries, true);
  state.totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  state.totalFiles = entries.filter((entry) => entry.kind !== "directory").length;
  const space = await statfs(target);
  if (space.bavail * space.bsize < state.totalBytes + 16 * 1024 * 1024) throw new Error("Not enough free space in the destination directory.");
  const mappings: Array<[string, string]> = [[source.data, next.data], [source.browser, next.browser],
    [await canonicalPath(source.data), next.data], [await canonicalPath(source.browser), next.browser]];
  const hashes = new Map<string, string>();
  state.stage = "copying";
  for (const entry of entries) {
    if (entry.kind === "directory") await mkdir(entry.to, { recursive: false, mode: 0o700 });
    else if (entry.kind === "link") {
      const kind = process.platform === "win32" && (await stat(entry.from)).isDirectory() ? "junction" : undefined;
      await symlink(relocatedLink(entry, mappings), entry.to, kind);
      state.completedFiles++;
    } else {
      const hash = createHash("sha256");
      await pipeline(createReadStream(entry.from), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          state.completedBytes += chunk.length;
          progress({ ...state });
          callback(null, chunk);
        },
      }), createWriteStream(entry.to, { flags: "wx", mode: 0o600 }));
      hashes.set(entry.from, hash.digest("hex"));
      const file = await open(entry.to, "r+");
      try { await file.sync(); } finally { await file.close(); }
      await chmod(entry.to, entry.mode & 0o777);
      state.completedFiles++;
    }
    progress({ ...state });
  }
  state.stage = "verifying"; state.completedBytes = 0; state.completedFiles = 0;
  progress({ ...state });
  for (const entry of entries) {
    if (entry.kind === "file") {
      const hash = hashes.get(entry.from);
      if (await digest(entry.to) !== hash || await digest(entry.from) !== hash) throw new Error("A storage file changed or failed verification; the original directory is still active.");
      state.completedBytes += entry.bytes; state.completedFiles++;
    } else if (entry.kind === "link") {
      if (await readlink(entry.to) !== relocatedLink(entry, mappings)) throw new Error("A symbolic link failed verification.");
      state.completedFiles++;
    }
    progress({ ...state });
  }
  state.stage = "relocating"; progress({ ...state });
  if (await optionalStat(source.data)) await relocate(source.data, next.data);
  // Restore permissions only after writing and verifying all descendants.
  for (const entry of entries.reverse()) if (entry.kind === "directory") await chmod(entry.to, entry.mode & 0o777);
  state.stage = "complete"; progress({ ...state });
  return next;
}
async function assertSeparate(target: string, source: StorageRoots, anchor: string) {
  const canonical = await realpath(target);
  if (canonical !== resolve(target)) throw new Error("Destination directory changed identity.");
  for (const path of [source.data, source.browser, anchor]) {
    const root = await canonicalPath(path);
    if (contains(root, canonical) || contains(canonical, root)) throw new Error("Unsafe overlapping storage directories.");
  }
}

async function safeCachePaths(roots: StorageRoots): Promise<string[]> {
  const candidates = DATA_CACHE_PATHS.map((path) => join(roots.data, path));
  candidates.push(...BROWSER_CACHE_PATHS.map((path) => join(roots.browser, path)));
  const partitions = join(roots.browser, "Partitions");
  if ((await optionalStat(partitions))?.isDirectory() && !(await lstat(partitions)).isSymbolicLink()) {
    for (const name of await readdir(partitions)) candidates.push(...BROWSER_CACHE_PATHS.map((path) => join(partitions, name, path)));
  }
  const result: string[] = [];
  for (const candidate of candidates) {
    const root = contains(roots.data, candidate) ? roots.data : roots.browser;
    if (!(await optionalStat(candidate))) continue;
    // Canonical containment also checks every intermediate directory, including plugin/partition links.
    const canonicalRoot = await realpath(root);
    const parent = await realpath(dirname(candidate));
    const info = await lstat(candidate);
    const expectedParent = join(canonicalRoot, relative(root, dirname(candidate)));
    if (parent !== expectedParent || !contains(canonicalRoot, parent) || info.isSymbolicLink()) continue;
    result.push(candidate);
  }
  return result;
}
export async function cacheSize(roots: StorageRoots): Promise<number> {
  let bytes = 0;
  for (const path of await safeCachePaths(roots)) {
    const entries: Entry[] = []; await inventory(path, path, entries);
    bytes += entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }
  return bytes;
}
export async function clearCaches(roots: StorageRoots): Promise<void> {
  for (const path of await safeCachePaths(roots)) await rm(path, { recursive: true, force: true });
}
export async function removeBackups(backups: StorageRoots[], active: StorageRoots, anchor: string): Promise<void> {
  const canonicalActive = [await canonicalPath(active.data), await canonicalPath(active.browser)];
  const canonicalAnchor = await realpath(anchor);
  const targets: Array<{ path: string; anchor: boolean }> = [];
  // Preflight the entire plan before deleting a single entry.
  for (const backup of backups) for (const path of [backup.data, backup.browser]) {
    if (!(await optionalStat(path))) continue;
    const canonical = await realpath(path);
    if (canonicalActive.some((root) => contains(canonical, root) || contains(root, canonical))) throw new Error("Backup overlaps active storage.");
    if (canonical !== canonicalAnchor && contains(canonical, canonicalAnchor)) throw new Error("Backup overlaps installation preferences.");
    targets.push({ path, anchor: canonical === canonicalAnchor });
  }
  for (const target of targets) {
    if (target.anchor) {
      // Keep the stable installation lock and bootstrap preference when removing the original Chromium profile.
      for (const name of await readdir(target.path)) if (!excluded(name)) await rm(join(target.path, name), { recursive: true, force: true });
    } else await rm(target.path, { recursive: true, force: true });
  }
}
