/**
 * Mode definition catalog (ADR mode-definitions).
 *
 * Electron main owns the user's global `~/.pi/modes` directory: it reads the
 * documents, hands them to the agent-runtime loader for strict validation, and
 * keeps the parsed catalog for the renderer and for the snapshots it attaches
 * to `session.configure`. Workspaces never provide modes.
 */
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  builtinModeSource,
  loadModeDefinitions,
  type UserModeDocument,
} from "@pi-desktop/agent-runtime";
import {
  BUILTIN_MODE_IDS,
  MODE_LIMITS,
  isModeId,
  type ModeCatalog,
  type ModeDefinition,
  type ModeDocumentReadResult,
  type ModeDocumentValidation,
} from "@pi-desktop/shared";

export const MODE_DOCUMENT_NAME = "mode.md";
const TEMPLATE_DIR = "templates";
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

async function readBoundedText(path: string): Promise<string | undefined> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MODE_LIMITS.fileBytes) return undefined;
  return readFile(path, "utf8");
}

async function readTemplates(modeDir: string): Promise<Record<string, string>> {
  const templates: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await readdir(join(modeDir, TEMPLATE_DIR));
  } catch (error) {
    if (isMissing(error)) return templates;
    throw error;
  }
  for (const name of entries.sort()) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const text = await readBoundedText(join(modeDir, TEMPLATE_DIR, name)).catch(() => undefined);
    if (text !== undefined) templates[`${TEMPLATE_DIR}/${name}`] = text;
  }
  return templates;
}

/** Read every `<dir>/mode.md`. An oversized document is still handed to the
 * loader (as empty source) so it is reported instead of silently missing. */
export async function readUserModeDocuments(dir: string = modeDefinitionsDir()): Promise<UserModeDocument[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const documents: UserModeDocument[] = [];
  for (const dirName of names.sort().slice(0, MAX_USER_MODE_DIRECTORIES)) {
    if (dirName.startsWith(".")) continue;
    const modeDir = join(dir, dirName);
    const filePath = join(modeDir, MODE_DOCUMENT_NAME);
    let source: string | undefined;
    try {
      if (!(await stat(modeDir)).isDirectory()) continue;
      source = await readBoundedText(filePath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    documents.push({
      dirName,
      filePath,
      source: source ?? "",
      templates: source === undefined ? {} : await readTemplates(modeDir),
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
   * `name:` and may differ from its directory, so the catalog's recorded
   * file wins; an id the catalog does not know lives in `<dir>/<id>`.
   * `occupiedBy` names another mode whose document already sits there.
   * File operations pass `rescan` so they act on the disk as it is now.
   */
  async function locate(
    id: string,
    rescan = false,
  ): Promise<{ modeDir: string; known: boolean; occupiedBy?: string }> {
    if (rescan) cache = null;
    const { catalog } = await current();
    const entries = catalog.modes.filter((entry) => entry.id === id && entry.source === "user" && !entry.reserved && entry.filePath);
    const entry = entries.find((candidate) => candidate.available) ?? entries[0];
    if (entry?.filePath) return { modeDir: dirname(entry.filePath), known: true };
    const modeDir = join(dir, id);
    const filePath = join(modeDir, MODE_DOCUMENT_NAME);
    const occupant = catalog.modes.find((candidate) => candidate.filePath === filePath);
    return { modeDir, known: false, ...(occupant ? { occupiedBy: occupant.id } : {}) };
  }


  function assertWritableId(id: string): void {
    if (!isModeId(id)) {
      throw modeError("MODE_ID_INVALID", "Mode ids use lowercase letters, digits and dashes and start with a letter");
    }
    if ((BUILTIN_MODE_IDS as readonly string[]).includes(id)) {
      throw modeError("MODE_ID_RESERVED", `"${id}" is a builtin mode; save a copy under another id`);
    }
  }

  async function validate(id: string, source: string): Promise<ModeDocumentValidation> {
    if (!isModeId(id)) return { ok: false, errors: ["name: invalid mode id"], warnings: [] };
    if ((BUILTIN_MODE_IDS as readonly string[]).includes(id)) {
      return { ok: false, errors: [`name: "${id}" is a builtin mode`], warnings: [] };
    }
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
    const templates = await readTemplates(modeDir).catch(() => ({}));
    const result = loadModeDefinitions({
      userDocuments: [{ dirName: basename(modeDir), filePath: join(modeDir, MODE_DOCUMENT_NAME), source, templates }],
    });
    const diagnostic = result.diagnostics.find((entry) => entry.modeId === id);
    const errors = diagnostic?.errors ?? [];
    const warnings = diagnostic?.warnings ?? [];
    const loaded = result.definitions.some((definition) => definition.id === id && definition.source === "user");
    if (!loaded) return { ok: false, errors: errors.length ? errors : ["mode could not be loaded"], warnings };
    return { ok: errors.length === 0, errors, warnings };
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
    async read(id: string): Promise<ModeDocumentReadResult> {
      const builtin = builtinModeSource(id);
      if (builtin !== undefined) return { id, source: builtin, builtin: true };
      if (!isModeId(id)) throw modeError("MODE_ID_INVALID", "invalid mode id");
      const filePath = join((await locate(id, true)).modeDir, MODE_DOCUMENT_NAME);
      try {
        return { id, source: await readFile(filePath, "utf8"), filePath, builtin: false };
      } catch (error) {
        if (isMissing(error)) throw modeError("MODE_NOT_FOUND", `Mode "${id}" does not exist`);
        throw error;
      }
    },
    validate,
    async write(id: string, source: string): Promise<ModeCatalog> {
      assertWritableId(id);
      const { modeDir } = await locate(id, true);
      const validation = await validate(id, source);
      if (!validation.ok) {
        throw modeError("MODE_DEFINITION_INVALID", validation.errors[0] ?? "invalid mode definition", {
          errors: validation.errors,
          warnings: validation.warnings,
        });
      }
      await mkdir(modeDir, { recursive: true });
      await writeFile(join(modeDir, MODE_DOCUMENT_NAME), source, "utf8");
      options.logger?.app("settings", "info", "mode definition saved", { data: { id } });
      return refresh();
    },
    async remove(id: string): Promise<ModeCatalog> {
      assertWritableId(id);
      const { modeDir, known } = await locate(id, true);
      if (!known) throw modeError("MODE_NOT_FOUND", `Mode "${id}" does not exist`);
      await rm(join(modeDir, MODE_DOCUMENT_NAME), { force: true });
      // Templates belong to the mode. The directory goes only when it is
      // empty, so nothing else the user put there is lost.
      await rm(join(modeDir, TEMPLATE_DIR), { recursive: true, force: true });
      await rmdir(modeDir).catch(() => undefined);
      options.logger?.app("settings", "info", "mode definition deleted", { data: { id } });
      return refresh();
    },
  };
}
