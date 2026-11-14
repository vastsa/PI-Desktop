import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type {
  FsChatRefMatch,
  FsChatRefMatchKind,
  FsChatRefProjectRoot,
  FsChatRefRoot,
  FsChatRefResolveResult,
} from "@pi-desktop/shared";
import { isAttachmentBlobRef, isIgnoredName, resolveRealPathWithinRoot } from "./workspace-files.js";
import { resolveExternalFile } from "./external-files.js";
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
 *   1. an absolute reference only names that exact file inside a known root;
 *   2. an `attachments/<sha256>` blob names a stored file by hash rather than
 *      by path, so it resolves against the attachment store directly;
 *   3. otherwise the roots are searched in priority order — the open project
 *      first, the session's own scratch store second, the attachment blob
 *      store last — and the first root that answers wins, so the project is
 *      searched to exhaustion before the scratch store is considered;
 *   4. inside one root an exact path wins; a shorthand resolves only when the
 *      complete supplied suffix matches one safe file. Ambiguous or shortened
 *      suffixes remain unresolved. An exact reference may additionally name a
 *      real directory when the caller passes `allowDirectory` (issue #2113);
 *      a shorthand never resolves to a directory.
 */

export type ChatRefRoots = {
  /**
   * Every folder of the open project, primary first (ADR 0249). A single-folder
   * project is a one-element list, so callers never special-case it.
   */
  project?: readonly FsChatRefProjectRoot[] | null;
  scratch?: string | null;
  /**
   * Roots an absolute reference may name without being searched by shorthand.
   *
   * A generated image lives in the scratch store of the session that produced
   * it, and the user clicks it from whatever conversation they are reading —
   * usually a later one. Every read guard (`fsRead`, `fsOpen`, the image
   * reader, `fsReveal`) already accepts the whole scratch store, so completing
   * against the session's own store alone reported a restriction for a file the
   * app can open. These entries widen the absolute-path check only: a shorthand
   * still searches the session's own root, so it never lands in another
   * session's files.
   */
  containment?: readonly ChatRefContainmentRoot[] | null;
  attachments?: string | null;
};

/** A root an absolute reference may name, though no shorthand searches it. */
export type ChatRefContainmentRoot = { kind: FsChatRefRoot; path: string };

/** A root to search, and — for a project folder — which folder it is. */
type ChatRefRootEntry = {
  kind: FsChatRefRoot;
  path: string;
  sessionScratch?: boolean;
  projectRoot?: FsChatRefProjectRoot;
};

type CanonicalChatRefRoot = ChatRefRootEntry & { realPath: string | null };

const MAX_REF_LENGTH = 512;
const ATTACHMENT_HASH_PATTERN = /^[0-9a-f]{64}$/i;
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

/**
 * Strip the composer sigil, optional quotes, and a file line reference, then
 * repair a Windows drive path that arrived rooted the POSIX way.
 */
function cleanRef(raw: string): string {
  let value = stripRefDecorations(String(raw ?? ""));
  if (value.includes("\0")) return "";
  value = value.replace(/(?::\d+(?::\d+|-\d+)?|#L\d+(?:-L?\d+)?)$/i, "");
  return normalizeDriveRef(value);
}

/**
 * A chat link may root a Windows drive path the way a POSIX example does:
 * `/f:/project/file.md` instead of `F:\project\file.md`. Both the transcript's
 * Markdown links and the agent's own prose spell paths that way, and on Windows
 * the leading `/` turns the drive into an ordinary directory name — `resolve()`
 * builds `F:\f:\project\file.md`, `realpath` misses, and a file that exists is
 * reported as missing.
 *
 * Only that shape is repaired here. Existence, root priority, and containment
 * stay the resolver's own decisions, and a POSIX host keeps `/c:/...`, which is
 * a real path there.
 */
const POSIX_ROOTED_DRIVE = /^\/+([A-Za-z]):\//;

function normalizeDriveRef(value: string): string {
  if (process.platform !== "win32") return value;
  const match = POSIX_ROOTED_DRIVE.exec(value);
  return match ? `${match[1].toUpperCase()}:/${value.slice(match[0].length)}` : value;
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
    list.push({ kind, path: resolve(value), ...(kind === "scratch" ? { sessionScratch: true } : {}) });
  }
  return list;
}

/**
 * The containment-only roots, in the same vocabulary as the searched ones.
 *
 * They answer absolute references and nothing else: the shorthand walk below
 * keeps searching `orderedRoots`, so a reference is never completed from
 * another session's store.
 */
function containmentEntries(roots: ChatRefRoots): ChatRefRootEntry[] {
  const list: ChatRefRootEntry[] = [];
  for (const root of roots.containment ?? []) {
    const path = String(root?.path ?? "").trim();
    if (!path) continue;
    list.push({ kind: root.kind, path: resolve(path) });
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

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
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

async function canonicalRoots(roots: ChatRefRootEntry[]): Promise<CanonicalChatRefRoot[]> {
  return Promise.all(roots.map(async (root) => {
    try {
      return { ...root, realPath: await realpath(root.path) };
    } catch {
      return { ...root, realPath: null };
    }
  }));
}

function couldShareVolume(target: string, roots: CanonicalChatRefRoot[]): boolean {
  if (process.platform !== "win32") return true;
  const volume = parse(target).root.toLowerCase();
  return roots.some((root) => [root.path, root.realPath].some(
    (path) => path && parse(path).root.toLowerCase() === volume,
  ));
}

async function canonicalPathOrMissingTail(path: string): Promise<string | null> {
  let ancestor = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...tail);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      tail.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function isChatRefOutsideRoots(ref: string, roots: ChatRefRoots): Promise<boolean> {
  const parsed = parseChatRef(ref);
  if (!parsed?.absolute) return false;
  const cleaned = cleanRef(ref);
  if (!isAbsolute(cleaned)) return true;
  const absolutePath = resolve(cleaned);
  const rootList = await canonicalRoots([...orderedRoots(roots), ...containmentEntries(roots)]);
  if (!couldShareVolume(absolutePath, rootList)) return true;
  const targetPath = await canonicalPathOrMissingTail(absolutePath);
  if (!targetPath) return !rootList.some((root) => relativeInside(root.path, absolutePath) !== null);
  return !rootList.some((root) =>
    root.realPath && relativeInside(root.realPath, targetPath) !== null,
  );
}

/**
 * Complete an absolute reference that `isChatRefOutsideRoots` placed outside
 * every managed root (ADR 0339). It names that exact file or nothing: a path
 * with no regular file behind it reports a miss, and no same-name file is ever
 * looked up anywhere else. A reference that is not an exact absolute path keeps
 * reporting the access limit, since shorthand never searches outside the roots.
 */
export async function resolveExternalChatRef(ref: string): Promise<FsChatRefResolveResult> {
  const parsed = parseChatRef(ref);
  const cleaned = cleanRef(ref);
  if (!parsed?.absolute || !isAbsolute(cleaned)) {
    return { match: null, reason: "outside-allowed-roots" };
  }
  const external = await resolveExternalFile(cleaned);
  if (external.kind === "file") {
    return {
      match: {
        root: "external",
        relativePath: basename(external.path),
        absolutePath: external.path,
        matchedBy: "exact-absolute",
      },
    };
  }
  return { match: null };
}

function segmentsOf(path: string): string[] {
  return toPosix(path).split("/").filter(Boolean);
}

function endsWithTail(fileSegments: readonly string[], tail: readonly string[]): boolean {
  if (fileSegments.length < tail.length) return false;
  const offset = fileSegments.length - tail.length;
  for (let index = 0; index < tail.length; index += 1) {
    if (!matchesSegment(fileSegments[offset + index], tail[index])) return false;
  }
  return true;
}

type FuzzyCandidate = { relativePath: string; matchedBy: FsChatRefMatchKind };

/** Only a unique candidate matching the complete supplied suffix is safe. */
function fuzzyCandidates(
  files: readonly string[],
  segments: readonly string[],
): FuzzyCandidate[] {
  return files
    .filter((file) => endsWithTail(segmentsOf(file), segments))
    .map((relativePath) => ({
      relativePath,
      matchedBy: segments.length === 1 ? "basename" : "path-suffix",
    }));
}

async function isContainedRegularFile(root: string, relativePath: string): Promise<boolean> {
  const realPath = await resolveRealPathWithinRoot(root, relativePath);
  return realPath !== null && isRegularFile(realPath);
}

/**
 * The same containment contract as `isContainedRegularFile` for an exact
 * directory reference: the real path must stay inside the root, so a symlinked
 * or dangling directory never matches (issue #2113).
 */
async function isContainedDirectory(root: string, relativePath: string): Promise<boolean> {
  const realPath = await resolveRealPathWithinRoot(root, relativePath);
  if (realPath === null) return false;
  try {
    return (await stat(realPath)).isDirectory();
  } catch {
    return false;
  }
}

async function hasInvalidLinkAncestor(root: string, segments: readonly string[]): Promise<boolean> {
  for (let length = 1; length <= segments.length; length += 1) {
    const prefixSegments = segments.slice(0, length);
    try {
      if ((await lstat(join(root, ...prefixSegments))).isSymbolicLink()
        && !(await resolveRealPathWithinRoot(root, prefixSegments.join("/")))) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only ordinary missing paths can fall back to an indexed suffix match.
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
  }
  return false;
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
 * With `allowDirectory` an exact reference may name a real directory inside
 * the roots instead; the match then carries `target: "directory"`.
 */
export type ChatRefResolveOptions = {
  /**
   * Let an exact reference name a real directory (issue #2113). Explicit
   * Markdown links carry this flag; shorthand and fuzzy completion never do,
   * so a directory named like the file a shorthand asks for keeps answering
   * nothing. The absolute branch still stays inside the managed roots — an
   * exact absolute path outside them keeps the ADR 0339 file-only contract.
   */
  allowDirectory?: boolean;
};

export async function resolveChatFileRef(
  ref: string,
  roots: ChatRefRoots,
  options: ChatRefResolveOptions = {},
): Promise<FsChatRefMatch | null> {
  const parsed = parseChatRef(ref);
  if (!parsed) return null;
  const rootList = orderedRoots(roots);
  if (rootList.length === 0 && !(roots.containment ?? []).length) return null;

  const cleanedPosixRef = toPosix(cleanRef(ref));
  const isAttachmentRef = /^attachments(?:\/|$)/i.test(cleanedPosixRef);

  // Absolute references must not select an unrelated in-root file by suffix.
  if (parsed.absolute) {
    const cleaned = cleanRef(ref);
    if (!isAbsolute(cleaned)) return null;
    const absolutePath = resolve(cleaned);
    // An absolute reference may also name a store the app reads but no shorthand
    // searches, such as an image another session generated.
    const canonicalRootList = await canonicalRoots([
      ...rootList,
      ...containmentEntries(roots),
    ]);
    if (!couldShareVolume(absolutePath, canonicalRootList)) return null;
    let targetPath: string;
    try {
      targetPath = await realpath(absolutePath);
    } catch {
      return null;
    }
    const regular = await isRegularFile(targetPath);
    if (!regular) {
      // An exact absolute directory inside a managed root resolves only when
      // the caller asked for directories (issue #2113); realpath has already
      // collapsed any link, so the root attribution below cannot escape.
      if (!options.allowDirectory || !(await isDirectory(targetPath))) return null;
    }
    for (const root of canonicalRootList) {
      const relativePath = root.realPath ? relativeInside(root.realPath, targetPath) : null;
      if (!relativePath) continue;
      return {
        root: root.kind,
        relativePath,
        absolutePath,
        matchedBy: "exact-absolute",
        ...(regular ? {} : { target: "directory" as const }),
        ...(root.sessionScratch ? { sessionScratch: true } : {}),
        ...(root.projectRoot ? { projectRoot: root.projectRoot } : {}),
      };
    }
    return null;
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
    if (!(await isContainedRegularFile(resolvedRoot, blobHash.toLowerCase()))) return null;
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
  for (const root of rootList) {
    const absolutePath = join(root.path, ...parsed.segments);
    if (await isRegularFile(absolutePath)) {
      if (!(await isContainedRegularFile(root.path, parsed.segments.join("/")))) return null;
      return {
        root: root.kind,
        relativePath: parsed.segments.join("/"),
        absolutePath,
        matchedBy: "exact-relative",
        ...(root.sessionScratch ? { sessionScratch: true } : {}),
        ...(root.projectRoot ? { projectRoot: root.projectRoot } : {}),
      };
    }
    // An exact directory reference answers before the fuzzy walk, and only
    // when the caller asked for directories (issue #2113). The containment
    // check doubles as the dangling-link guard: a junction pointing outside
    // the root (or at nothing) resolves to null, never to the link path.
    if (
      options.allowDirectory
      && (await isContainedDirectory(root.path, parsed.segments.join("/")))
    ) {
      return {
        root: root.kind,
        relativePath: parsed.segments.join("/"),
        absolutePath,
        matchedBy: "exact-relative",
        target: "directory",
        ...(root.sessionScratch ? { sessionScratch: true } : {}),
        ...(root.projectRoot ? { projectRoot: root.projectRoot } : {}),
      };
    }
    if (await hasInvalidLinkAncestor(root.path, parsed.segments)) return null;
    const candidates = fuzzyCandidates(
      await listRootFiles(root.kind, root.path),
      parsed.segments,
    );
    const safeCandidates: FuzzyCandidate[] = [];
    for (const candidate of candidates) {
      if (await isContainedRegularFile(root.path, candidate.relativePath)) {
        safeCandidates.push(candidate);
        if (safeCandidates.length > 1) return null;
      }
    }
    const candidate = safeCandidates[0];
    if (candidate) {
      return {
        root: root.kind,
        relativePath: candidate.relativePath,
        absolutePath: join(root.path, ...segmentsOf(candidate.relativePath)),
        matchedBy: candidate.matchedBy,
        ...(root.sessionScratch ? { sessionScratch: true } : {}),
        ...(root.projectRoot ? { projectRoot: root.projectRoot } : {}),
      };
    }
  }

  return null;
}
