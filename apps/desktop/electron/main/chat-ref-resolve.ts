import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  FsChatRefMatch,
  FsChatRefMatchKind,
  FsChatRefProjectRoot,
  FsChatRefRoot,
} from "@pi-desktop/shared";
import { isAttachmentBlobRef, isIgnoredName } from "@pi-desktop/host-runtime";
import { getWorkspaceFileIndex } from "./fs-index.js";

/**
 * Partial-path completion for a file reference the agent printed in chat.
 *
 * An agent that works on `/root/dir/openimage.js` routinely names only
 * `openimage.js` in its prose. The transcript linkified that token against the
 * workspace root alone, so the click resolved to a path that does not exist and
 * the work panel painted an empty state instead of the file.
 *
 * Resolution order is the product contract:
 *
 *   1. an absolute reference that already names a real file inside a known
 *      root wins outright — that is path equality, not a guess;
 *   2. an `attachments/<sha256>` blob names a stored file by hash rather than
 *      by path, so it resolves against the attachment store directly;
 *   3. otherwise the roots are searched in priority order — the open project
 *      first, the session's own scratch store second, the attachment blob
 *      store last — and the first root that answers wins, so the project is
 *      searched to exhaustion before the scratch store is considered;
 *   4. inside one root an exact path beats a shorthand, and among shorthands
 *      the longest matching tail wins, then the shallowest path, so
 *      `src/dir/a.ts` beats a second `dir/a.ts` buried deeper.
 */

export type ChatRefRoots = {
  /**
   * Every folder of the open project, primary first (ADR 0249). A single-folder
   * project is a one-element list, so callers never special-case it.
   */
  project?: readonly FsChatRefProjectRoot[] | null;
  scratch?: string | null;
  attachments?: string | null;
};

/** A root to search, and — for a project folder — which folder it is. */
type ChatRefRootEntry = {
  kind: FsChatRefRoot;
  path: string;
  projectRoot?: FsChatRefProjectRoot;
};

const MAX_REF_LENGTH = 512;
const ATTACHMENT_HASH_PATTERN = /^[0-9a-f]{64}$/i;
/** A tail longer than this is a user quoting a full path, not a shorthand. */
const MAX_FUZZY_TAIL_SEGMENTS = 6;
/** Bound for the scratch/attachment walk; those trees are small by design. */
const MAX_ROOT_WALK_ENTRIES = 4000;

/**
 * Windows and macOS compare filenames case-insensitively; Linux does not.
 * An exact-case match still wins on a tie, so this only widens the net.
 */
const CASE_INSENSITIVE_FS =
  process.platform === "win32" || process.platform === "darwin";

function toPosix(value: string): string {
  return String(value).replaceAll("\\", "/");
}

function matchesSegment(candidate: string, wanted: string): boolean {
  if (candidate === wanted) return true;
  return CASE_INSENSITIVE_FS && candidate.toLowerCase() === wanted.toLowerCase();
}

/** Strip the composer sigil, optional quotes, and a `:line[:col]` reference. */
function cleanRef(raw: string): string {
  let value = stripRefDecorations(String(raw ?? ""));
  if (value.includes("\0")) return "";
  value = value.replace(/:\d+(?::\d+)?$/, "");
  return value;
}

function stripRefDecorations(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("@")) value = value.slice(1).trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

export type ParsedChatRef = {
  /** Path segments with `.` dropped and `..` collapsed. */
  segments: string[];
  /** Whether the original token anchored at a filesystem root. */
  absolute: boolean;
};

/**
 * Parse a chat file token. Returns null for `~`-prefixed home paths, empty
 * tokens, oversized tokens, and any token whose `..` walk leaves the start.
 */
export function parseChatRef(raw: string): ParsedChatRef | null {
  const value = cleanRef(raw);
  if (!value || value.length > MAX_REF_LENGTH) return null;
  if (value.startsWith("~")) return null;

  const posix = toPosix(value);
  const absolute =
    posix.startsWith("/") ||
    /^[a-z]:\//i.test(posix) ||
    posix.startsWith("//");

  const segments: string[] = [];
  for (const segment of posix.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return { segments, absolute };
}

/**
 * Product priority: the open project first, then session scratch, then
 * attachments. Inside the project the order is the group's own order, primary
 * first, so the folder the agent's tools default to answers before its siblings
 * — and the first root that answers still wins outright.
 */
function orderedRoots(roots: ChatRefRoots): ChatRefRootEntry[] {
  const list: ChatRefRootEntry[] = [];
  for (const root of roots.project ?? []) {
    const path = String(root?.path ?? "").trim();
    if (!path) continue;
    list.push({ kind: "workspace", path: resolve(path), projectRoot: root });
  }
  for (const kind of ["scratch", "attachments"] as const) {
    const value = roots[kind];
    if (typeof value !== "string" || !value.trim()) continue;
    list.push({ kind, path: resolve(value) });
  }
  return list;
}

async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Root-relative POSIX path, or null when `absolute` is outside `rootPath`. */
function relativeInside(rootPath: string, absolute: string): string | null {
  const rel = relative(rootPath, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return toPosix(rel);
}

function segmentsOf(path: string): string[] {
  return toPosix(path).split("/").filter(Boolean);
}

/** Fewer segments first, then a stable lexicographic order. */
function compareCandidates(a: string, b: string): number {
  const depthDelta = segmentsOf(a).length - segmentsOf(b).length;
  if (depthDelta !== 0) return depthDelta;
  return a.localeCompare(b);
}

function endsWithTail(fileSegments: string[], tail: string[]): boolean {
  if (fileSegments.length < tail.length) return false;
  const offset = fileSegments.length - tail.length;
  for (let index = 0; index < tail.length; index += 1) {
    if (!matchesSegment(fileSegments[offset + index], tail[index])) return false;
  }
  return true;
}

type FuzzyCandidate = { relativePath: string; matchedBy: FsChatRefMatchKind };

/**
 * Longest tail first, so a two-segment shorthand beats a bare leaf name.
 * Within one tail the shallowest file wins.
 */
function bestFuzzyCandidate(
  files: readonly string[],
  tails: readonly string[][],
): FuzzyCandidate | null {
  const parsedFiles = files.map((file) => ({
    file,
    segments: segmentsOf(file),
  }));
  for (const tail of tails) {
    let best: string | null = null;
    for (const entry of parsedFiles) {
      if (!endsWithTail(entry.segments, tail)) continue;
      if (best === null || compareCandidates(entry.file, best) < 0) {
        best = entry.file;
      }
    }
    if (best !== null) {
      return {
        relativePath: best,
        matchedBy: tail.length === 1 ? "basename" : "path-suffix",
      };
    }
  }
  return null;
}

/** Bounded walk for trees with no git index (session scratch, attachments). */
async function walkRootFiles(
  rootPath: string,
  budget: number,
): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && files.length < budget) {
    const rel = queue.shift() as string;
    let dirents;
    try {
      dirents = await readdir(join(rootPath, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (isIgnoredName(dirent.name)) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        queue.push(childRel);
      } else if (dirent.isFile()) {
        files.push(childRel);
        if (files.length >= budget) break;
      }
    }
  }
  return files;
}

/**
 * The project goes through the composer's cached index, which already carries
 * gitignore semantics and the files-tab ignore set; scratch and attachments
 * have no index and are walked directly.
 */
async function listRootFiles(
  kind: FsChatRefRoot,
  rootPath: string,
): Promise<string[]> {
  if (kind === "workspace") {
    const index = await getWorkspaceFileIndex(rootPath);
    return index.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path);
  }
  return walkRootFiles(rootPath, MAX_ROOT_WALK_ENTRIES);
}

/**
 * Resolve one chat file reference to the best existing file, or null when
 * nothing matches. Never throws: an unreadable root is simply not a match.
 */
export async function resolveChatFileRef(
  ref: string,
  roots: ChatRefRoots,
): Promise<FsChatRefMatch | null> {
  const parsed = parseChatRef(ref);
  if (!parsed) return null;
  const rootList = orderedRoots(roots);
  if (rootList.length === 0) return null;

  const cleanedPosixRef = toPosix(cleanRef(ref));
  const isAttachmentRef = /^attachments(?:\/|$)/i.test(cleanedPosixRef);

  // 1. An absolute reference that already names a real path inside a known root
  //    is unambiguous evidence, so it outranks every shorthand rule below. A
  //    POSIX-style path on Windows finds nothing here, which is correct: step 2
  //    then treats its tail as the shorthand it is.
  if (parsed.absolute) {
    const absolutePath = resolve(cleanRef(ref));
    for (const root of rootList) {
      const relativePath = relativeInside(root.path, absolutePath);
      if (!relativePath) continue;
      if (await isRegularFile(absolutePath)) {
        return {
          root: root.kind,
          relativePath,
          absolutePath,
          matchedBy: "exact-absolute",
          ...(root.projectRoot ? { projectRoot: root.projectRoot } : {}),
        };
      }
    }
  }

  // 2. A content-addressed attachment blob (`attachments/<sha256>`) is not a
  //    filesystem path: it names a stored blob by hash, and the files-tab
  //    contract spells it that way. Resolve it against the attachment root
  //    directly instead of searching for a path that cannot exist.
  if (isAttachmentRef) {
    if (!isAttachmentBlobRef(cleanedPosixRef)) return null;
    const attachmentsRoot = roots.attachments;
    if (!attachmentsRoot) return null;
    const blobHash = segmentsOf(cleanedPosixRef).at(-1);
    if (!blobHash || !ATTACHMENT_HASH_PATTERN.test(blobHash)) return null;
    const resolvedRoot = resolve(attachmentsRoot);
    const absolutePath = join(resolvedRoot, blobHash.toLowerCase());
    if (!absolutePath.startsWith(resolvedRoot + sep) && absolutePath !== resolvedRoot) {
      return null;
    }
    if (!(await isRegularFile(absolutePath))) return null;
    return {
      root: "attachments",
      relativePath: blobHash.toLowerCase(),
      absolutePath,
      matchedBy: "exact-relative",
    };
  }

  // 3. Roots in product priority order, and the first root that answers wins
  //    outright: the open project is searched to exhaustion before the session
  //    scratch store is considered at all. Inside one root the reference read
  //    as a path verbatim outranks a tail match.
  const tails: string[][] = [];
  const longestTail = Math.min(parsed.segments.length, MAX_FUZZY_TAIL_SEGMENTS);
  for (let length = longestTail; length >= 1; length -= 1) {
    tails.push(parsed.segments.slice(parsed.segments.length - length));
  }
  for (const root of rootList) {
    if (!parsed.absolute) {
      const absolutePath = join(root.path, ...parsed.segments);
      if (await isRegularFile(absolutePath)) {
        return {
          root: root.kind,
          relativePath: parsed.segments.join("/"),
          absolutePath,
          matchedBy: "exact-relative",
          ...(root.projectRoot ? { projectRoot: root.projectRoot } : {}),
        };
      }
    }
    const candidate = bestFuzzyCandidate(
      await listRootFiles(root.kind, root.path),
      tails,
    );
    if (!candidate) continue;
    return {
      root: root.kind,
      relativePath: candidate.relativePath,
      absolutePath: join(root.path, ...segmentsOf(candidate.relativePath)),
      matchedBy: candidate.matchedBy,
      ...(root.projectRoot ? { projectRoot: root.projectRoot } : {}),
    };
  }

  return null;
}
