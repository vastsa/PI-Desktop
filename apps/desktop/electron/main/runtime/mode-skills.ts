/**
 * Mode-private skills (issue #2544 §3).
 *
 * A mode directory is a copyable configuration unit, so the skills that belong
 * to it live in `<modeDir>/skills/` and travel with a copy. The host discovers
 * and validates the documents itself — dropping a `SKILL.md` folder in is the
 * whole registration step — and the only state the user toggles is the mode's
 * own `disabledSkills` list. Nothing here writes a SKILL.md and nothing here
 * touches the global skill registry.
 *
 * Identity is scoped by mode even when two modes, or a mode and the global
 * registry, use the same local name: the catalog id is `mode:<mode>/<local>`.
 * A stale `/skill:` selection, a disabled entry, a moved directory, or a mode
 * switch therefore cannot load another mode's document, and cannot fall back
 * to a same-named global skill. Every call re-reads the mode, its bundle and
 * the directory, so a selection made against an older catalog fails instead
 * of silently loading what used to be there.
 *
 * Only a new-format `mode.yaml` mode owns private skills: a legacy `mode.md`
 * mode has no bundle, so it advertises none. Reads go through the same safe
 * reader `mode.yaml` references use, which means a symlinked, junctioned or
 * hardlinked document — or an aliased `skills/` root — is refused rather than
 * followed out of the mode directory.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseSkillFrontmatter } from "@pi-desktop/plugin-sdk";
import { MODE_SKILL_ID_RE, MODE_SKILLS_DIR } from "@pi-desktop/shared";
import type { LoadedSkillDocument } from "../skill-document";

/** Claude-style skill document name: `<skills>/<name>/SKILL.md`. */
export const MODE_SKILL_DOCUMENT = "SKILL.md";
/** Prefix that keeps a mode skill distinct from a global or plugin skill id. */
export const MODE_SKILL_ID_PREFIX = "mode:";
/** Same cap host-core applies to a user skill document. */
const MAX_MODE_SKILL_BYTES = 128 * 1024;
const MAX_MODE_SKILLS = 128;
/** A mode skill keeps the skill catalog id shape, which `disabledSkills` uses. */
const SCOPED_SKILL_ID_RE = /^mode:([a-z][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9-]{0,63})$/;

/**
 * The slice of the mode catalog this module needs.
 *
 * `skillsDirectory` resolves `<modeDir>/skills` and, in the real catalog,
 * rescans `~/.pi/modes` while doing so. That refresh is why this module always
 * resolves the directory *before* reading `definition`: the other order would
 * answer with the bundle the catalog cached before the user's last edit, and a
 * skill switched off a moment ago would still be advertised.
 */
export type ModeSkillCatalog = {
  skillsDirectory: (mode: string, create?: boolean) => Promise<string>;
  definition: (mode: string) => Promise<{
    bundle?: { disabledSkills?: readonly string[] };
  } | undefined>;
};

/** A skill document found in one mode's `skills/` folder. */
export type DiscoveredModeSkill = {
  /** Local id inside the mode: the directory name, slugged. */
  id: string;
  name: string;
  description?: string;
  /** Absolute path of the SKILL.md (or bare `<id>.md`) document. */
  path: string;
  /** Mode-relative reference the safe reader takes, e.g. `skills/x/SKILL.md`. */
  reference: string;
};

/** One row of the mode's read-only skill list in Settings. */
export type ModeSkillListing = { id: string; name: string; enabled: boolean };

function modeSkillError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function slug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** The catalog id of a mode's private skill. */
export function modeSkillId(mode: string, localId: string): string {
  return `${MODE_SKILL_ID_PREFIX}${mode}/${localId}`;
}

/** Split a mode-scoped id, or `null` when the id belongs to another source. */
export function parseModeSkillId(id: string): { mode: string; localId: string } | null {
  const match = SCOPED_SKILL_ID_RE.exec(id);
  return match ? { mode: match[1], localId: match[2] } : null;
}

export function isModeSkillId(id: string): boolean {
  return parseModeSkillId(id) !== null;
}

/**
 * The mode directory a resolved `skills/` path belongs to, or a refusal.
 *
 * The skills root is a link target an outside process could swap, so the
 * directory handed to this module must be a real `<modeDir>/skills` path: a
 * differently named directory (which is what a link swap produces) is refused
 * instead of scanned. The entry itself is `lstat`ed later, so a junction at
 * `skills/` never becomes a walk into another tree.
 */
function modeDirFor(skillsDir: string): string {
  const resolved = resolve(skillsDir);
  if (basename(resolved) !== MODE_SKILLS_DIR) {
    throw modeSkillError(
      "MODE_SKILLS_NOT_DIRECTORY",
      `"${basename(resolved)}" is not a mode's skills directory`,
    );
  }
  return dirname(resolved);
}

/** True when `path` is a real file or directory, never a link. */
async function isRealEntry(path: string): Promise<"file" | "dir" | null> {
  const info = await lstat(path).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return null;
  if (info.isDirectory()) return "dir";
  if (info.isFile()) return "file";
  return null;
}

/**
 * The mode root and its `skills/` folder must both be real directories.
 *
 * `lstat` reports the link itself, so a junctioned mode directory — which would
 * make "inside the mode" mean an unrelated tree — and a linked `skills/` folder
 * are refused before anything below them is read. Ancestors are not checked:
 * `~/.pi/modes` may legitimately sit under a linked home, and this boundary is
 * the mode directory, not the filesystem above it.
 */
async function isRealModeTree(modeDir: string, skillsDir: string): Promise<boolean> {
  if ((await isRealEntry(modeDir)) !== "dir") return false;
  return (await isRealEntry(skillsDir)) === "dir";
}

/**
 * Read one mode-relative document without following a link or a hardlink.
 *
 * This mirrors the discipline `mode.yaml` references already use: every path
 * segment is `lstat`ed (a `stat` would follow a junction), the open refuses a
 * symbolic link that appeared in between, and the descriptor's link count
 * catches a hardlink — which has no path-level signal at all. A document the
 * mode does not exclusively own is reported, never read.
 */
async function readSkillDocument(
  modeDir: string,
  reference: string,
): Promise<{ text: string | null; problem?: string }> {
  const segments = reference.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    return { text: null, problem: "not a managed skills reference" };
  }
  let current = resolve(modeDir);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!info) return { text: null, problem: "not found in the mode directory" };
    if (info.isSymbolicLink()) {
      return { text: null, problem: "is a symbolic link; copy the skill into the mode instead" };
    }
    const isLast = index === segments.length - 1;
    if (!isLast && !info.isDirectory()) return { text: null, problem: "is not a directory" };
    if (isLast && !info.isFile()) return { text: null, problem: "is not a regular file" };
    if (isLast && info.size > MAX_MODE_SKILL_BYTES) {
      return { text: null, problem: `larger than ${MAX_MODE_SKILL_BYTES} bytes` };
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) return { text: null, problem: "is not a regular file" };
    if (info.nlink > 1) {
      return { text: null, problem: "is hardlinked; copy the skill into the mode instead" };
    }
    if (info.size > MAX_MODE_SKILL_BYTES) {
      return { text: null, problem: `larger than ${MAX_MODE_SKILL_BYTES} bytes` };
    }
    return { text: await handle.readFile({ encoding: "utf8" }) };
  } catch (error) {
    if (isMissing(error)) return { text: null, problem: "not found in the mode directory" };
    return { text: null, problem: "could not be read" };
  } finally {
    await handle?.close();
  }
}

function entryFor(
  localId: string,
  reference: string,
  documentPath: string,
  source: string,
): DiscoveredModeSkill | undefined {
  const parsed = parseSkillFrontmatter(source);
  // A document without instructions cannot be followed, so it is not a skill.
  if (!parsed.body.trim()) return undefined;
  const id = slug(localId);
  if (!MODE_SKILL_ID_RE.test(id)) return undefined;
  return {
    id,
    name: parsed.name?.trim() || localId,
    ...(parsed.description?.trim() ? { description: parsed.description.trim() } : {}),
    path: documentPath,
    reference,
  };
}

/**
 * Skills a mode folder provides, sorted by local id.
 *
 * Both on-disk shapes are accepted: `<name>/SKILL.md` (the form the Settings
 * page tells the user to copy in) and a bare `<name>.md`. A malformed, empty,
 * oversized or linked document is skipped rather than failing the whole list,
 * so one bad folder cannot hide the rest of the mode's skills — and a link is
 * never followed out of the mode directory.
 */
export async function discoverModeSkills(skillsDir: string): Promise<DiscoveredModeSkill[]> {
  const modeDir = modeDirFor(skillsDir);
  // A missing `skills/` is an empty catalog, and a linked mode root or a
  // linked `skills/` folder is not a catalog at all: scanning either would
  // follow the link into a tree this mode does not own.
  if (!(await isRealModeTree(modeDir, skillsDir))) return [];
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const found: DiscoveredModeSkill[] = [];
  const seen = new Set<string>();
  for (const name of entries.sort().slice(0, MAX_MODE_SKILLS)) {
    if (name.startsWith(".") || name.includes("/") || name.includes("\\")) continue;
    const absolute = join(skillsDir, name);
    // `lstat`, so a junctioned skill folder is skipped instead of walked.
    const shape = await isRealEntry(absolute);
    if (!shape) continue;
    const [localId, reference, documentPath] =
      shape === "dir"
        ? [name, `${MODE_SKILLS_DIR}/${name}/${MODE_SKILL_DOCUMENT}`, join(absolute, MODE_SKILL_DOCUMENT)]
        : /\.md$/i.test(name)
          ? [name.replace(/\.md$/i, ""), `${MODE_SKILLS_DIR}/${name}`, absolute]
          : [undefined, undefined, undefined];
    if (localId === undefined || reference === undefined || documentPath === undefined) continue;
    const { text } = await readSkillDocument(modeDir, reference);
    if (text === null) continue;
    const skill = entryFor(localId, reference, documentPath, text);
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    found.push(skill);
  }
  return found.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The mode's own policy for private skills, read in the one order that is
 * fresh: resolving the directory rescans `~/.pi/modes`, so the definition read
 * right after it carries the switches the user just saved. Reading the
 * definition first would answer from the catalog cached before that edit and
 * advertise a skill that was switched off a moment ago.
 *
 * `undefined` means the directory is a legacy `mode.md` mode: it has no
 * `mode.yaml`, so it owns no private skills at all. Callers must treat that as
 * "none", never as "no switches, everything enabled".
 */
async function modeSkillPolicy(
  catalog: ModeSkillCatalog,
  mode: string,
): Promise<{ modeDir: string; disabled: ReadonlySet<string> } | undefined> {
  if (typeof catalog.skillsDirectory !== "function") {
    throw modeSkillError(
      "MODE_SKILLS_UNAVAILABLE",
      "This host cannot resolve a mode's skills directory",
    );
  }
  const skillsDir = await catalog.skillsDirectory(mode, false);
  const definition = await catalog.definition(mode);
  if (!definition) {
    throw modeSkillError("MODE_NOT_FOUND", `Mode "${mode}" is not available`);
  }
  if (!definition.bundle) return undefined;
  return {
    modeDir: modeDirFor(skillsDir),
    disabled: new Set(definition.bundle.disabledSkills ?? []),
  };
}

/**
 * The launch-time variant: a mode whose private skills cannot be read offers
 * none instead of failing the session. Offering nothing is the closed
 * direction, and the composer and the `Skill` tool still refuse a stale id
 * because they resolve the same catalog on their own.
 */
export async function enabledModeSkillsOrNone(
  catalog: ModeSkillCatalog | undefined,
  mode: string,
): Promise<Array<{ id: string; name: string; description?: string }>> {
  if (!catalog || typeof catalog.skillsDirectory !== "function") return [];
  return enabledModeSkills(catalog, mode).catch(() => []);
}

/**
 * The mode's skills as Settings shows them: read-only id/name plus the toggle
 * state. `disabledSkills` holds local ids, so that is what `id` reports; the
 * runtime catalog uses the mode-scoped form instead.
 */
export async function listModeSkills(
  catalog: ModeSkillCatalog,
  mode: string,
): Promise<ModeSkillListing[]> {
  const policy = await modeSkillPolicy(catalog, mode);
  // A legacy `mode.md` mode owns no private skills: the read-only list is empty
  // rather than the directory's contents, which the mode does not manage.
  if (!policy) return [];
  const discovered = await discoverModeSkills(join(policy.modeDir, MODE_SKILLS_DIR));
  return discovered.map((skill) => ({
    id: skill.id,
    name: skill.name,
    enabled: !policy.disabled.has(skill.id),
  }));
}

/**
 * The mode skills a session may use, as composer/runtime catalog entries.
 *
 * Ids are mode-scoped, so the same local name in another mode is a different
 * entry and a global skill of that name is a different id too. A read failure
 * propagates: the caller decides whether an empty menu or a refusal is right.
 */
export async function enabledModeSkills(
  catalog: ModeSkillCatalog,
  mode: string,
): Promise<Array<{ id: string; name: string; description?: string }>> {
  const policy = await modeSkillPolicy(catalog, mode);
  if (!policy) return [];
  const discovered = await discoverModeSkills(join(policy.modeDir, MODE_SKILLS_DIR));
  return discovered
    .filter((skill) => !policy.disabled.has(skill.id))
    .map((skill) => ({
      id: modeSkillId(mode, skill.id),
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    }));
}

/**
 * Load one mode-private document for the `Skill` tool.
 *
 * `null` means "not a mode skill" so the caller can try the next source. Every
 * other outcome is a refusal, decided against the catalog as it is now:
 * a mode-scoped id naming another mode, a legacy `mode.md` mode, a mode that
 * no longer loads, a skill the user disabled, and a skill whose folder was
 * moved, deleted or replaced by a link all throw instead of falling back to a
 * same-named skill.
 */
export async function loadModeSkillDocument(
  catalog: ModeSkillCatalog,
  sessionMode: string,
  id: string,
): Promise<LoadedSkillDocument | null> {
  const scoped = parseModeSkillId(id);
  if (!scoped) return null;
  if (scoped.mode !== sessionMode) {
    throw modeSkillError(
      "MODE_SKILL_MODE_MISMATCH",
      `Skill "${id}" belongs to mode "${scoped.mode}", not to the current mode "${sessionMode}"`,
    );
  }
  // Policy first, and in the fresh order: the switch state decides before any
  // document is touched, so a skill turned off a moment ago cannot be loaded
  // through a stale catalog read.
  const policy = await modeSkillPolicy(catalog, scoped.mode);
  if (!policy) {
    // A legacy `mode.md` mode owns no private skills, so this id names nothing
    // it could legitimately have advertised.
    throw modeSkillError(
      "MODE_SKILL_NOT_FOUND",
      `Mode "${scoped.mode}" has no private skills; its definition is a legacy mode.md`,
    );
  }
  if (policy.disabled.has(scoped.localId)) {
    throw modeSkillError(
      "MODE_SKILL_DISABLED",
      `Skill "${scoped.localId}" is turned off in mode "${scoped.mode}"`,
    );
  }
  const discovered = await discoverModeSkills(join(policy.modeDir, MODE_SKILLS_DIR));
  const skill = discovered.find((candidate) => candidate.id === scoped.localId);
  if (!skill) {
    throw modeSkillError(
      "MODE_SKILL_NOT_FOUND",
      `Skill "${scoped.localId}" is no longer available in mode "${scoped.mode}"`,
    );
  }
  // Re-read through the safe reader: discovery proved the folder is a real one
  // a moment ago, and the body still has to come from a document the mode owns.
  const { text, problem } = await readSkillDocument(policy.modeDir, skill.reference);
  if (text === null) {
    throw modeSkillError(
      "MODE_SKILL_NOT_FOUND",
      `Skill "${scoped.localId}" could not be read in mode "${scoped.mode}"${problem ? `: it ${problem}` : ""}`,
    );
  }
  const parsed = parseSkillFrontmatter(text);
  if (!parsed.body.trim()) {
    throw modeSkillError(
      "MODE_SKILL_NOT_FOUND",
      `Skill "${scoped.localId}" has no instructions in mode "${scoped.mode}"`,
    );
  }
  return {
    id: modeSkillId(scoped.mode, skill.id),
    name: parsed.name?.trim() || skill.name,
    body: parsed.body,
    location: skill.path,
  };
}

type SessionModeReader = {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

/**
 * Wire the module to the running processes: the composer asks for one mode's
 * catalog entries, the `Skill` tool asks for one document, and Settings asks
 * for the row list. The session's mode is read from the host on every load so
 * a switch mid-session is honored immediately.
 */
export function createModeSkillRuntime(deps: {
  catalog: ModeSkillCatalog;
  getHost: () => SessionModeReader | null;
}) {
  /** Current mode of a session, as the host persists it. */
  async function sessionMode(sessionId: string): Promise<string> {
    const host = deps.getHost();
    if (!host) {
      throw modeSkillError("HOST_UNAVAILABLE", "mode skills need the host to resolve a session mode");
    }
    const detail = await host.call<{ session?: { mode?: string } | null }>("session.get", {
      id: sessionId,
      messageLimit: 1,
    });
    const mode = detail?.session?.mode;
    if (typeof mode !== "string" || !mode) {
      throw modeSkillError("MODE_NOT_FOUND", `Session "${sessionId}" has no mode`);
    }
    return mode;
  }

  return {
    /** Composer/runtime catalog for `mode`; ids are mode-scoped. */
    catalog: (mode: string) => enabledModeSkills(deps.catalog, mode),
    /** Settings rows for `mode`; ids are the writable `disabledSkills` values. */
    list: (mode: string) => listModeSkills(deps.catalog, mode),
    /** `Skill` tool lookup, refused when the selection no longer applies. */
    async loadForSession(id: string, sessionId: string): Promise<LoadedSkillDocument | null> {
      if (!isModeSkillId(id)) return null;
      const mode = await sessionMode(sessionId);
      return loadModeSkillDocument(deps.catalog, mode, id);
    },
  };
}

export type ModeSkillRuntime = ReturnType<typeof createModeSkillRuntime>;
