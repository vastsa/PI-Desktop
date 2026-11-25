/**
 * Mode definition catalog (ADR mode-definitions, issue #2544).
 *
 * Electron main owns the user's global `~/.pi/modes` directory: it reads the
 * documents, hands them to the agent-runtime loader for strict validation, and
 * keeps the parsed catalog for the renderer and for the snapshots it attaches
 * to `session.configure`. Workspaces never provide modes.
 *
 * Two document formats coexist:
 *
 * - new format — `<dir>/mode.yaml`, which names the mode's prompt document and
 *   its private subagent documents by relative path and carries the mode's
 *   skill switches. A directory with one never reads, merges or falls back to
 *   `mode.md`, and an invalid bundle is reported by file and field instead of
 *   loading partially;
 * - legacy — `<dir>/mode.md`, one Markdown document whose frontmatter declares
 *   the workflow. Existing documents keep working unchanged.
 *
 * Creation writes the new format; legacy documents remain editable in place.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  builtinModeSource,
  loadModeDefinitions,
  type UserModeDocument,
} from "@pi-desktop/agent-runtime";
import {
  BUILTIN_MODE_IDS,
  MODE_BUNDLE_FILE,
  MODE_DOCUMENT_FILE,
  MODE_LIMITS,
  isModeId,
  type ModeCatalog,
  type ModeDefinition,
  type ModeDocumentReadResult,
  type ModeDocumentValidation,
} from "@pi-desktop/shared";
import {
  copyModeBundle,
  inspectModeDirectory,
  modeSkillsDirectory,
  readLegacyModeTemplates,
  readModeBundle,
  readModeBundleFile,
  readUserModeBundle,
  removeModeFiles,
  writeLegacyMode,
  writeModeBundle,
} from "./mode-bundle-storage";

export const MODE_DOCUMENT_NAME = MODE_DOCUMENT_FILE;
export { MODE_BUNDLE_FILE };

function isBuiltinId(id: string): boolean {
  return (BUILTIN_MODE_IDS as readonly string[]).includes(id);
}
const MAX_USER_MODE_DIRECTORIES = 64;

export function modeDefinitionsDir(): string {
  return join(homedir(), ".pi", "modes");
}

function modeError(errorCode: string, message: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...(data ? { data: { errorCode, ...data } } : {}) });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Read a YAML manifest first. An unusable manifest never falls back to mode.md. */
export async function readUserModeDocuments(dir: string = modeDefinitionsDir()): Promise<UserModeDocument[]> {
  if (!(await inspectModeDirectory(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const documents: UserModeDocument[] = [];
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries.slice(0, MAX_USER_MODE_DIRECTORIES)) {
    const dirName = entry.name;
    if (dirName.startsWith(".") || !entry.isDirectory()) continue;
    const modeDir = join(dir, dirName);
    const filePath = join(modeDir, MODE_DOCUMENT_NAME);
    const { templates, ...bundle } = await readUserModeBundle(modeDir);
    if (bundle.source !== null || bundle.problem) {
      documents.push({
        dirName,
        filePath,
        source: "",
        templates,
        bundle,
      });
      continue;
    }
    const legacy = await readModeBundleFile(modeDir, MODE_DOCUMENT_NAME, MODE_LIMITS.fileBytes);
    if (legacy.text === null && !legacy.problem) continue;
    documents.push({
      dirName,
      filePath,
      source: legacy.text ?? "",
      templates: legacy.text === null ? {} : await readLegacyModeTemplates(modeDir, legacy.text),
    });
  }
  return documents;
}

type LoadedCatalog = { catalog: ModeCatalog; definitions: Map<string, ModeDefinition> };

export type ModeCatalogService = ReturnType<typeof createModeCatalogService>;

export function createModeCatalogService(options: {
  dir?: string;
  onChanged?: (catalog: ModeCatalog) => void;
  logger?: { app: (...args: any[]) => void };
} = {}) {
  const dir = options.dir ?? modeDefinitionsDir();
  let cache: Promise<LoadedCatalog> | null = null;

  async function load(): Promise<LoadedCatalog> {
    const userDocuments = await readUserModeDocuments(dir);
    const result = loadModeDefinitions({ userDocuments });
    return {
      catalog: { modes: result.catalog, diagnostics: result.diagnostics, directory: dir },
      definitions: new Map(result.definitions.map((definition) => [definition.id, definition])),
    };
  }

  function current(): Promise<LoadedCatalog> {
    cache ??= load().catch((error: unknown) => {
      cache = null;
      throw error;
    });
    return cache;
  }

  /** Re-read the directory. Listeners hear about it only when the catalog
   * actually changed, so a plain read does not fan out a redundant event. */
  async function refresh(): Promise<ModeCatalog> {
    const previous = cache;
    cache = null;
    const { catalog } = await current();
    const before = previous ? await previous.then((loaded) => loaded.catalog, () => undefined) : undefined;
    if (!before || JSON.stringify(before) !== JSON.stringify(catalog)) options.onChanged?.(catalog);
    return catalog;
  }

  /**
   * Directory that holds the user mode `id`. A mode's id comes from its
   * `name:` and may differ from its directory, so the catalog's recorded file
   * wins; an id the catalog does not know lives in `<dir>/<id>`.
   * `occupiedBy` names another mode whose document already sits there.
   * File operations pass `rescan` so they act on the disk as it is now.
   */
  async function locate(
    id: string,
    rescan = false,
  ): Promise<{ modeDir: string; known: boolean; occupiedBy?: string }> {
    if (rescan) cache = null;
    const { catalog } = await current();
    if (isBuiltinId(id)) {
      // A builtin's override always lives in the folder named after it.
      const builtin = catalog.modes.find((entry) => entry.id === id && entry.source === "builtin");
      return { modeDir: join(dir, id), known: builtin?.customized === true };
    }
    const entries = catalog.modes.filter((entry) => entry.id === id && entry.source === "user" && !entry.reserved && entry.filePath);
    const entry = entries.find((candidate) => candidate.available) ?? entries[0];
    if (entry?.filePath) {
      return { modeDir: dirname(entry.filePath), known: true };
    }
    const modeDir = join(dir, id);
    const filePath = join(modeDir, MODE_DOCUMENT_NAME);
    const bundlePath = join(modeDir, MODE_BUNDLE_FILE);
    const occupant = catalog.modes.find(
      (candidate) => candidate.filePath === filePath || candidate.filePath === bundlePath,
    );
    return {
      modeDir,
      known: false,
      ...(occupant ? { occupiedBy: occupant.id } : {}),
    };
  }

  function assertWritableId(id: string): void {
    if (!isModeId(id)) {
      throw modeError("MODE_ID_INVALID", "Mode ids use lowercase letters, digits and dashes and start with a letter");
    }
  }

  /**
   * Validate a document before it is written.
   *
   * A legacy Markdown source keeps the exact validation it had. A YAML source
   * (`source` starting a `mode.yaml` map) is validated as a bundle against the
   * documents already on disk, so a save reports the same errors a reload
   * would.
   */
  async function validate(id: string, source: string): Promise<ModeDocumentValidation> {
    if (!isModeId(id)) return { ok: false, errors: ["name: invalid mode id"], warnings: [] };
    if (Buffer.byteLength(source) > MODE_LIMITS.fileBytes) {
      return { ok: false, errors: [`file: larger than ${MODE_LIMITS.fileBytes} bytes`], warnings: [] };
    }
    const { modeDir, occupiedBy } = await locate(id);
    if (occupiedBy !== undefined) {
      return {
        ok: false,
        errors: [`name: the directory "${basename(modeDir)}" already holds the mode "${occupiedBy}"`],
        warnings: [],
      };
    }
    if (isModeBundleSource(source)) {
      return validateBundle(id, modeDir, source);
    }
    const templates = await readLegacyModeTemplates(modeDir, source);
    const result = loadModeDefinitions({
      userDocuments: [{ dirName: basename(modeDir), filePath: join(modeDir, MODE_DOCUMENT_NAME), source, templates }],
    });
    const diagnostic = result.diagnostics.find((entry) => entry.modeId === id);
    const errors = diagnostic?.errors ?? [];
    const warnings = diagnostic?.warnings ?? [];
    // An override loads in place of the builtin, under the builtin's id.
    const loaded = result.definitions.some((definition) => definition.id === id && definition.source === "user");
    if (!loaded) return { ok: false, errors: errors.length ? errors : ["mode could not be loaded"], warnings };
    return { ok: errors.length === 0, errors, warnings };
  }

  /**
   * Validate a `mode.yaml` body against the documents the directory already has.
   *
   * A reference the map names but the directory does not have is reported as
   * missing, so a draft that points at a file the user has not written yet
   * cannot look valid. Nothing here writes anything.
   */
  async function validateBundle(
    id: string,
    modeDir: string,
    source: string,
  ): Promise<ModeDocumentValidation> {
    const { templates, ...bundle } = await readUserModeBundle(modeDir, { source });
    const result = loadModeDefinitions({
      userDocuments: [{
        dirName: basename(modeDir),
        filePath: join(modeDir, MODE_DOCUMENT_NAME),
        source: "",
        templates,
        bundle,
      }],
    });
    const diagnostic = result.diagnostics.find((entry) => entry.modeId === id);
    const errors = diagnostic?.errors ?? [];
    const warnings = diagnostic?.warnings ?? [];
    const loaded = result.definitions.some((definition) => definition.id === id && definition.bundle !== undefined);
    if (!loaded) return { ok: false, errors: errors.length ? errors : ["the bundle could not be loaded"], warnings };
    return { ok: errors.length === 0, errors, warnings };
  }

  /** Read one bundle: the `mode.yaml` text and every document it names. */
  async function readBundle(id: string): Promise<{ source: string; prompt: string; agents: Record<string, string> }> {
    assertWritableId(id);
    const { modeDir } = await locate(id, true);
    const contents = await readModeBundle(modeDir);
    if (contents.source === null) {
      if (contents.problem) throw modeError("MODE_BUNDLE_UNREADABLE", `Mode "${id}" ${MODE_BUNDLE_FILE}: ${contents.problem}`);
      throw modeError("MODE_NOT_FOUND", `Mode "${id}" has no ${MODE_BUNDLE_FILE}`);
    }
    return { source: contents.source, prompt: contents.prompt, agents: contents.agents };
  }

  return {
    directory: dir,
    /** Rescans `~/.pi/modes`, so edits made outside the app show up. */
    catalog: (): Promise<ModeCatalog> => refresh(),
    refresh,
    /** Parsed definition, or undefined for an unknown or unavailable id. */
    definition: async (id: string): Promise<ModeDefinition | undefined> => (await current()).definitions.get(id),
    /**
     * Snapshot attached to `session.configure`. Agent and Plan keep their
     * builtin Host semantics and need none; every other mode must resolve.
     */
    async snapshotFor(mode: string): Promise<ModeDefinition | undefined> {
      if (mode === "agent" || mode === "plan") return undefined;
      const definition = (await current()).definitions.get(mode);
      if (!definition) throw modeError("MODE_NOT_FOUND", `Mode "${mode}" is not available`);
      return definition;
    },
    /**
     * Document of a mode, for the settings editor. A bundle directory returns
     * its `mode.yaml`; a legacy directory returns `mode.md`; a builtin without
     * an override returns the shipped source.
     */
    async read(id: string): Promise<ModeDocumentReadResult> {
      const builtin = builtinModeSource(id);
      if (builtin === undefined && !isModeId(id)) throw modeError("MODE_ID_INVALID", "invalid mode id");
      const { modeDir } = await locate(id, true);
      for (const reference of [MODE_BUNDLE_FILE, MODE_DOCUMENT_NAME]) {
        const file = await readModeBundleFile(modeDir, reference, MODE_LIMITS.fileBytes);
        if (file.problem) throw modeError("MODE_BUNDLE_UNREADABLE", `${reference}: ${file.problem}`);
        if (file.text !== null) {
          return { id, source: file.text, filePath: join(modeDir, reference), builtin: builtin !== undefined };
        }
      }
      if (builtin !== undefined) return { id, source: builtin, builtin: true };
      throw modeError("MODE_NOT_FOUND", `Mode "${id}" does not exist`);
    },
    validate,
    readBundle,
    /**
     * Write a document.
     *
     * A YAML source is written as a bundle through `writeBundle`, so a caller
     * that only edits `mode.yaml` cannot accidentally erase the documents it
     * references. A Markdown source keeps the legacy behaviour exactly.
     */
    async write(id: string, source: string): Promise<ModeCatalog> {
      assertWritableId(id);
      if (isModeBundleSource(source)) {
        const current = await readBundle(id).catch(() => undefined);
        return writeBundle(id, {
          source,
          prompt: current?.prompt ?? "",
          agents: current?.agents ?? {},
        });
      }
      const { modeDir, known } = await locate(id, true);
      const validation = await validate(id, source);
      if (!validation.ok) {
        throw modeError("MODE_DEFINITION_INVALID", validation.errors[0] ?? "invalid mode definition", {
          errors: validation.errors,
          warnings: validation.warnings,
        });
      }
      await writeLegacyMode(modeDir, source, known);
      options.logger?.app("settings", "info", "mode definition saved", { data: { id } });
      return refresh();
    },
    writeBundle,
    copy,
    skillsDirectory,
    /** For a builtin, deletes its override and restores the shipped definition. */
    async remove(id: string): Promise<ModeCatalog> {
      assertWritableId(id);
      const { modeDir, known } = await locate(id, true);
      if (!known) throw modeError("MODE_NOT_FOUND", `Mode "${id}" does not exist`);
      const removed = await removeModeFiles(modeDir);
      if (!removed) {
        // Unmanaged files can keep the directory in place without keeping a mode active.
        options.logger?.app("settings", "info", "mode files removed, directory kept", { data: { id } });
      }
      options.logger?.app("settings", "info", "mode definition deleted", { data: { id } });
      return refresh();
    },
  };

  /**
   * Write a whole bundle: `mode.yaml` plus the prompt and the private agent
   * documents it references. Nothing is written unless every reference stays
   * inside the mode directory and every document the map names is supplied;
   * `writeModeBundle` enforces both before it touches the disk.
   */
  async function writeBundle(
    id: string,
    contents: { source: string; prompt: string; agents: Record<string, string> },
  ): Promise<ModeCatalog> {
    assertWritableId(id);
    const { modeDir, occupiedBy, known } = await locate(id, true);
    if (occupiedBy !== undefined) {
      throw modeError(
        "MODE_DEFINITION_INVALID",
        `the directory "${basename(modeDir)}" already holds the mode "${occupiedBy}"`,
      );
    }
    await writeModeBundle(modeDir, contents, known);
    options.logger?.app("settings", "info", "mode bundle saved", { data: { id } });
    return refresh();
  }

  /** Duplicate the bundle and its scoped skills, leaving unrelated files in place. */
  async function copy(fromId: string, toId: string): Promise<ModeCatalog> {
    assertWritableId(fromId);
    assertWritableId(toId);
    if (fromId === toId) throw modeError("MODE_ID_INVALID", "a mode cannot be copied onto itself");
    if (isBuiltinId(toId)) {
      throw modeError("MODE_ID_INVALID", `"${toId}" is a builtin mode id; choose another name`);
    }
    const from = await locate(fromId, true);
    if (!from.known) throw modeError("MODE_NOT_FOUND", `Mode "${fromId}" does not exist`);
    const to = await locate(toId, false);
    if (to.occupiedBy !== undefined) {
      throw modeError("MODE_DEFINITION_INVALID", `the directory "${basename(to.modeDir)}" already holds the mode "${to.occupiedBy}"`);
    }
    await copyModeBundle(from.modeDir, to.modeDir);
    options.logger?.app("settings", "info", "mode bundle copied", { data: { from: fromId, to: toId } });
    return refresh();
  }

  /** `skills/` of a mode, so settings can open it in the file manager. */
  async function skillsDirectory(id: string, create = false): Promise<string> {
    assertWritableId(id);
    const { modeDir } = await locate(id, true);
    return modeSkillsDirectory(modeDir, create);
  }
}

/**
 * Whether a source is a `mode.yaml` body rather than a legacy document.
 *
 * A legacy `mode.md` may start with `---` frontmatter or with plain text, and
 * its frontmatter always sits between `---` lines — it is a Markdown document.
 * A `mode.yaml` is a plain map, so it starts with a `key:` line. Deciding by
 * shape (rather than by which editor the user opened) is what lets the same
 * `write` call keep both formats working.
 */
export function isModeBundleSource(source: string): boolean {
  const text = source.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  if (!text) return false;
  if (text.startsWith("---")) return false;
  return /^[A-Za-z][A-Za-z0-9_]*\s*:(\s|$)/.test(text);
}
