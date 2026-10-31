import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fuzzyMatchPath,
  selectBestMatches,
  type FsIndexEntry,
  type FsIndexResult,
} from "@pi-desktop/shared";
import { isIgnoredName } from "./workspace-files.js";

/**
 * Workspace file index for the composer "@" menu (D124, ADR 0024).
 *
 * Served from the main process like the files tab (ADR 0019): user-driven
 * browsing must not round-trip agent tools or permission prompts. The index
 * prefers `git ls-files` for exact gitignore semantics and falls back to a
 * bounded walk over the panel's ignore set. The renderer fuzzy-filters the
 * snapshot itself; when the snapshot is truncated, a query is also answered
 * here from the full listing (D669).
 */

export const FS_INDEX_MAX_ENTRIES = 8000;
/** Most entries a query searches when the snapshot is truncated. */
const FS_SEARCH_MAX_ENTRIES = 200_000;
/** The composer menu shows at most this many file rows. */
const FS_SEARCH_MAX_RESULTS = 50;
/** `fuzzyMatchPath` lowercases the query once per entry. */
const FS_SEARCH_MAX_QUERY = 256;
const SEARCH_WALK_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 4000;
const MAX_GIT_BUFFER = 32 * 1024 * 1024;

/** Shallow-first entries; `complete` is false when a cap or timeout cut them short. */
type Listing = { entries: FsIndexEntry[]; complete: boolean };
type CacheSlot = {
  at: number;
  index: FsIndexResult;
  listing: Listing;
  /** The listing came from the snapshot-sized walk, so a query may deepen it. */
  walked: boolean;
  deeper?: Promise<Listing>;
};
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
    // A filename's UTF-8 bytes can straddle stdout chunks.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
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
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ files: string[]; dirs: string[]; exhausted: boolean }> {
  const files: string[] = [];
  const dirs: string[] = [];
  let exhausted = false;
  const queue: string[] = [""];
  for (let next = 0; next < queue.length; next += 1) {
    if (Date.now() > deadline) {
      exhausted = true;
      break;
    }
    const rel = queue[next]!;
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

function toListing(files: string[], dirs: string[], complete: boolean): Listing {
  const entries: FsIndexEntry[] = [
    ...dirs.map((path): FsIndexEntry => ({ path, kind: "dir" })),
    ...files.map((path): FsIndexEntry => ({ path, kind: "file" })),
  ].sort(compareEntries);
  if (entries.length > FS_SEARCH_MAX_ENTRIES) {
    return { entries: entries.slice(0, FS_SEARCH_MAX_ENTRIES), complete: false };
  }
  return { entries, complete };
}

async function walkListing(root: string, budget: number, deadline?: number): Promise<Listing> {
  const walked = await walkFiles(root, budget, deadline);
  return toListing(walked.files, walked.dirs, !walked.exhausted);
}

async function buildSlot(root: string): Promise<CacheSlot> {
  const viaGit = await gitListFiles(root);
  let listing: Listing;
  if (viaGit) {
    // -o lists untracked-but-not-ignored files; repos without a .gitignore
    // would still surface build output, so the panel ignore set applies too.
    const files = viaGit.filter((p) => !hasIgnoredSegment(p));
    listing = toListing(files, dirsFromFilePaths(files), true);
  } else {
    listing = await walkListing(root, FS_INDEX_MAX_ENTRIES + 1);
  }
  const { entries, complete } = listing;
  const index =
    entries.length > FS_INDEX_MAX_ENTRIES
      ? { entries: entries.slice(0, FS_INDEX_MAX_ENTRIES), truncated: true }
      : { entries, truncated: !complete };
  return { at: Date.now(), index, listing, walked: !viaGit };
}

/** TTL-cached workspace listing; concurrent calls share one build. */
const pending = new Map<string, Promise<CacheSlot>>();

function slotFor(root: string): Promise<CacheSlot> {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached);
  const inFlight = pending.get(root);
  if (inFlight) return inFlight;
  const build = buildSlot(root)
    .then((slot) => {
      cache.set(root, slot);
      // A large tree's listing is held for the TTL only, not until the next build.
      setTimeout(() => {
        if (cache.get(root) === slot) cache.delete(root);
      }, CACHE_TTL_MS).unref();
      return slot;
    })
    .finally(() => {
      pending.delete(root);
    });
  pending.set(root, build);
  return build;
}

export async function getWorkspaceFileIndex(root: string): Promise<FsIndexResult> {
  return (await slotFor(root)).index;
}

/**
 * The best `limit` entries for an "@" query over the whole listing, ranked
 * like the renderer ranks the snapshot. A truncated snapshot keeps the
 * shallowest entries, so deep files of a large tree can only be found here
 * (#1781). A listing from the snapshot-sized walk is deepened once per slot.
 */
export async function searchWorkspaceFiles(
  root: string,
  query: string,
  limit = FS_SEARCH_MAX_RESULTS,
): Promise<FsIndexResult> {
  const needle = query.trim().slice(0, FS_SEARCH_MAX_QUERY);
  if (!needle) return { entries: [], truncated: false };
  const slot = await slotFor(root);
  const listing =
    slot.walked && !slot.listing.complete
      ? await (slot.deeper ??= walkListing(
          root,
          FS_SEARCH_MAX_ENTRIES,
          Date.now() + SEARCH_WALK_TIMEOUT_MS,
        ))
      : slot.listing;
  const best = selectBestMatches(matchEntries(listing.entries, needle), limit, (hit) => ({
    score: hit.score,
    text: hit.entry.path,
  }));
  return { entries: best.map((hit) => hit.entry), truncated: !listing.complete };
}

function* matchEntries(
  entries: FsIndexEntry[],
  query: string,
): Generator<{ entry: FsIndexEntry; score: number }> {
  for (const entry of entries) {
    const match = fuzzyMatchPath(query, entry.path, entry.kind);
    if (match) yield { entry, score: match.score };
  }
}
