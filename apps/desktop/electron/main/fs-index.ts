import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FsIndexEntry, FsIndexResult } from "@pi-desktop/shared";
import { isIgnoredName } from "./fs-panel.js";

/**
 * Workspace file index for the composer "@" menu (D124, ADR 0024).
 *
 * Served from the main process like the files tab (ADR 0019): user-driven
 * browsing must not round-trip agent tools or permission prompts. The index
 * prefers `git ls-files` for exact gitignore semantics and falls back to a
 * bounded walk over the panel's ignore set. Fuzzy filtering happens in the
 * renderer; this only snapshots relative paths.
 */

export const FS_INDEX_MAX_ENTRIES = 8000;
const CACHE_TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 4000;
const MAX_GIT_BUFFER = 32 * 1024 * 1024;

type CacheSlot = { at: number; result: FsIndexResult };
const cache = new Map<string, CacheSlot>();

function hasIgnoredSegment(path: string): boolean {
  for (const segment of path.split("/")) {
    if (isIgnoredName(segment)) return true;
  }
  return false;
}

/** `git ls-files -co --exclude-standard -z`, null when git is unusable. */
function gitListFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: root, env: process.env },
    );
    let out = "";
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.length > MAX_GIT_BUFFER) {
        failed = true;
        child.kill();
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) return resolve(null);
      resolve(out.split("\0").filter((p) => p.length > 0));
    });
  });
}

/** Bounded recursive walk honoring the files-tab ignore set. */
async function walkFiles(
  root: string,
  budget: number,
): Promise<{ files: string[]; dirs: string[]; exhausted: boolean }> {
  const files: string[] = [];
  const dirs: string[] = [];
  let exhausted = false;
  const queue: string[] = [""];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (isIgnoredName(dirent.name)) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      // Symlinks are skipped: the snapshot must never cycle or leave root.
      if (dirent.isDirectory()) {
        dirs.push(childRel);
        queue.push(childRel);
      } else if (dirent.isFile()) {
        files.push(childRel);
      }
      if (files.length + dirs.length >= budget) {
        exhausted = true;
        queue.length = 0;
        break;
      }
    }
  }
  return { files, dirs, exhausted };
}

function dirsFromFilePaths(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let at = file.indexOf("/");
    while (at > 0) {
      dirs.add(file.slice(0, at));
      at = file.indexOf("/", at + 1);
    }
  }
  return [...dirs];
}

function depth(path: string): number {
  let count = 0;
  for (const ch of path) if (ch === "/") count += 1;
  return count;
}

/** Shallow entries first so truncation keeps the top-level tree visible. */
function compareEntries(a: FsIndexEntry, b: FsIndexEntry): number {
  const depthDelta = depth(a.path) - depth(b.path);
  if (depthDelta !== 0) return depthDelta;
  return a.path.localeCompare(b.path);
}

async function buildIndex(root: string): Promise<FsIndexResult> {
  const viaGit = await gitListFiles(root);
  let files: string[];
  let dirs: string[];
  let exhausted = false;
  if (viaGit) {
    // -o lists untracked-but-not-ignored files; repos without a .gitignore
    // would still surface build output, so the panel ignore set applies too.
    files = viaGit.filter((p) => !hasIgnoredSegment(p));
    dirs = dirsFromFilePaths(files);
  } else {
    const walked = await walkFiles(root, FS_INDEX_MAX_ENTRIES + 1);
    files = walked.files;
    dirs = walked.dirs;
    exhausted = walked.exhausted;
  }

  const entries: FsIndexEntry[] = [
    ...dirs.map((path): FsIndexEntry => ({ path, kind: "dir" })),
    ...files.map((path): FsIndexEntry => ({ path, kind: "file" })),
  ].sort(compareEntries);

  if (entries.length > FS_INDEX_MAX_ENTRIES) {
    return { entries: entries.slice(0, FS_INDEX_MAX_ENTRIES), truncated: true };
  }
  return { entries, truncated: exhausted };
}

/** TTL-cached workspace index; concurrent calls share one build. */
const pending = new Map<string, Promise<FsIndexResult>>();

export async function getWorkspaceFileIndex(root: string): Promise<FsIndexResult> {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  const inFlight = pending.get(root);
  if (inFlight) return inFlight;
  const build = buildIndex(root)
    .then((result) => {
      cache.set(root, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      pending.delete(root);
    });
  pending.set(root, build);
  return build;
}
