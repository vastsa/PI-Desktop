/** Disk ownership and link checks for the mode catalog (issue #2544). */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import {
  MODE_BUNDLE_FILE,
  MODE_DOCUMENT_FILE,
  MODE_LIMITS,
  MODE_SKILLS_DIR,
  isModeId,
  normalizeModeBundlePath,
  type ModeDefinition,
} from "@pi-desktop/shared";
import {
  parseModeBundle,
  parseStrictModeYaml,
  readModeBundleReferences,
  renameModeBundle,
  splitModeDocument,
  type ModeBundleReferencesResult,
  type UserModeBundle,
  type UserModeBundleFile,
} from "@pi-desktop/agent-runtime";
import { discoverModeSkills } from "./mode-skills";

const TEMPLATE_DIR = "templates";
const MAX_PROMPT_FILE_BYTES = MODE_LIMITS.promptBytes * 2;

export type ModeBundleError = Error & { errorCode: string; data?: Record<string, unknown> };

function bundleError(errorCode: string, message: string, data?: Record<string, unknown>): ModeBundleError {
  return Object.assign(new Error(message), {
    errorCode,
    ...(data ? { data: { errorCode, ...data } } : {}),
  });
}

function invalid(message: string): ModeBundleError {
  return bundleError("MODE_DEFINITION_INVALID", message);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorMessage(error: unknown): string {
  if (code(error) === "ELOOP") return "is a symbolic link; copy the file into the mode instead";
  if (code(error) === "EACCES" || code(error) === "EPERM") return "is not readable";
  return error instanceof Error ? error.message : String(error);
}

async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Check ancestors top down: lstat of the leaf alone would follow a junction above it. */
export async function inspectModeDirectory(path: string): Promise<Stats | undefined> {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  let info = await statIfPresent(root);
  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    if (!info) return undefined;
    current = join(current, segment);
    info = await statIfPresent(current);
    if (info?.isSymbolicLink()) throw invalid(`${basename(current)}: is a symbolic link or junction`);
    if (info && !info.isDirectory()) throw invalid(`${basename(current)}: is not a directory`);
  }
  return info;
}

export function isInsideDirectory(root: string, candidate: string): boolean {
  const from = resolve(root);
  const to = resolve(candidate);
  return from === to || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`);
}

export function resolveBundleReference(
  modeDir: string,
  reference: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const normalized = normalizeModeBundlePath(reference);
  if (!normalized.ok) return normalized;
  const segments = normalized.path.split("/");
  if (segments.some((part) => /[:<>"|?*\u0000-\u001f]|[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(part))) {
    return { ok: false, error: "must use portable file names, without device names, streams or trailing dots/spaces" };
  }
  const target = resolve(modeDir, ...segments);
  if (!isInsideDirectory(modeDir, target)) return { ok: false, error: "must stay inside the mode directory" };
  return { ok: true, path: target };
}

function referencePath(modeDir: string, reference: string): string {
  if (reference !== reference.trim()) throw invalid(`${reference}: uses a noncanonical file name`);
  const resolved = resolveBundleReference(modeDir, reference);
  if (!resolved.ok) throw invalid(`${reference}: ${resolved.error}`);
  return resolved.path;
}

function fileProblem(info: Stats): string | undefined {
  if (info.isSymbolicLink()) return "is a symbolic link; copy the file into the mode instead";
  if (!info.isFile()) return "is not a regular file";
  if (info.nlink !== 1) return "is hardlinked; copy the file into the mode instead";
  return undefined;
}

async function inspectModeFile(path: string): Promise<Stats | undefined> {
  const parent = dirname(path);
  if (!(await inspectModeDirectory(parent))) return undefined;
  const info = await statIfPresent(path);
  if (!info) return undefined;
  const problem = fileProblem(info);
  if (problem) throw invalid(problem);
  // A trusted ancestor can use a Windows short name (for example TEMP), but
  // a reference's leaf must actually have the name it claims.
  if (process.platform === "win32" && basename(await realpath(path)).toLowerCase() !== basename(path).toLowerCase()) {
    throw invalid("uses an aliased file name");
  }
  return info;
}

function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a: Stats, b: Stats): boolean {
  return sameEntry(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Bounded, byte-preserving read; verify the opened file before reading any data. */
async function readModeBytes(path: string, maxBytes: number): Promise<{ bytes: Buffer; info: Stats } | undefined> {
  const expected = await inspectModeFile(path);
  if (!expected) return undefined;
  if (expected.size > maxBytes) throw invalid(`larger than ${maxBytes} bytes`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    const problem = fileProblem(info);
    if (problem) throw invalid(problem);
    if (!sameVersion(info, expected) || !(await inspectModeDirectory(dirname(path)))) {
      throw invalid("changed while being opened");
    }
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length !== info.size || !sameVersion(info, await handle.stat())) throw invalid("changed while being read");
    return { bytes: bytes.subarray(0, length), info };
  } finally {
    await handle.close();
  }
}

/** A missing file has no problem; a present but unusable file never counts as missing. */
export async function readModeBundleFile(
  modeDir: string,
  reference: string,
  maxBytes: number,
): Promise<UserModeBundleFile> {
  const resolved = resolveBundleReference(modeDir, reference);
  if (!resolved.ok) return { path: reference, text: null, problem: resolved.error };
  const { path: filePath } = resolved;
  try {
    const file = await readModeBytes(filePath, maxBytes);
    return { path: reference, filePath, text: file?.bytes.toString("utf8") ?? null };
  } catch (error) {
    return { path: reference, filePath, text: null, problem: errorMessage(error) };
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : undefined;
}

function templateReferences(frontmatter: unknown): string[] {
  const value = recordOf(frontmatter)?.artifacts;
  if (value === undefined) return [];
  const artifacts = recordOf(value);
  if (!artifacts) throw invalid("artifacts: expected a map of artifact ids");
  const entries = Object.entries(artifacts);
  if (entries.length > MODE_LIMITS.artifacts) throw invalid(`artifacts: at most ${MODE_LIMITS.artifacts} entries`);
  const references = new Map<string, string>();
  for (const [id, artifact] of entries) {
    const fields = recordOf(artifact);
    if (!fields) throw invalid(`artifacts.${id}: expected a map`);
    const template = typeof fields.template === "string" ? fields.template.trim() : fields.template;
    if (template === undefined || template === null) continue;
    if (typeof template !== "string" || !template.startsWith(`${TEMPLATE_DIR}/`) || !template.endsWith(".md")) {
      throw invalid(`artifacts.${id}.template: expected a Markdown path under ${TEMPLATE_DIR}/`);
    }
    const key = template.toLowerCase();
    const existing = references.get(key);
    if (existing !== undefined && existing !== template) throw invalid(`artifacts.${id}.template: conflicts with "${existing}"`);
    references.set(key, template);
  }
  return [...references.values()];
}

function legacyFrontmatter(source: string): unknown {
  const split = splitModeDocument(source);
  if (!split.ok) throw invalid(split.error);
  if (split.frontmatter === undefined) return undefined;
  const yaml = parseStrictModeYaml(split.frontmatter);
  if (!yaml.ok) throw invalid(yaml.errors[0] ?? "invalid mode.md frontmatter");
  return yaml.value;
}

export async function readLegacyModeTemplates(modeDir: string, source: string): Promise<Record<string, string>> {
  let references: string[];
  try {
    references = templateReferences(legacyFrontmatter(source));
  } catch (error) {
    if (!(error instanceof Error && "errorCode" in error)) throw error;
    // The definition parser diagnoses invalid frontmatter/template fields.
    return {};
  }
  return readTemplates(modeDir, references);
}

/** Read only the templates the entry point names. */
async function readTemplates(modeDir: string, references: string[]): Promise<Record<string, string>> {
  const templates: Record<string, string> = {};
  for (const reference of references) {
    const file = await readModeBundleFile(modeDir, reference, MODE_LIMITS.fileBytes);
    if (file.text !== null) templates[reference] = file.text;
  }
  return templates;
}

type BundleDocument = { reference: string; label: "promptFile" | "subagents"; maxBytes: number };

type BundlePaths = { documents: BundleDocument[]; templates: string[] };

function documentPaths(parsed: ModeBundleReferencesResult): BundlePaths {
  if (!parsed.ok) {
    throw bundleError("MODE_DEFINITION_INVALID", parsed.errors[0] ?? "invalid mode.yaml", { errors: parsed.errors });
  }
  const documents: BundleDocument[] = [
    { reference: parsed.references.promptFile, label: "promptFile", maxBytes: MAX_PROMPT_FILE_BYTES },
    ...parsed.references.subagents.map((reference): BundleDocument => ({ reference, label: "subagents", maxBytes: MODE_LIMITS.fileBytes })),
  ];
  const templates = templateReferences(parsed.frontmatter);
  const claimed = [MODE_BUNDLE_FILE, MODE_DOCUMENT_FILE, MODE_SKILLS_DIR];
  for (const { reference, label } of [...documents, ...templates.map((reference) => ({ reference, label: "template" }))]) {
    const key = reference.toLowerCase();
    if (key === TEMPLATE_DIR || claimed.some((other) => other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`))) {
      throw invalid(`${label}: "${reference}" conflicts with another bundle path`);
    }
    claimed.push(key);
  }
  return { documents, templates };
}

/** Read the manifest and referenced texts for the catalog or editor. */
export async function readUserModeBundle(
  modeDir: string,
  options: { source?: string; maxPromptBytes?: number; maxAgentBytes?: number } = {},
): Promise<UserModeBundle & { templates: Record<string, string> }> {
  const manifest = options.source === undefined
    ? await readModeBundleFile(modeDir, MODE_BUNDLE_FILE, MODE_LIMITS.fileBytes)
    : { text: options.source, filePath: join(modeDir, MODE_BUNDLE_FILE), problem: undefined };
  const filePath = manifest.filePath ?? join(modeDir, MODE_BUNDLE_FILE);
  const { text: source, problem } = manifest;
  const bundle: UserModeBundle & { templates: Record<string, string> } = {
    filePath, source, ...(problem ? { problem } : {}), subagents: [], templates: {},
  };
  if (source === null) return bundle;
  const parsed = readModeBundleReferences(source);
  if (!parsed.ok) return bundle;
  let paths: BundlePaths;
  try {
    paths = documentPaths(parsed);
  } catch (error) {
    bundle.prompt = { path: parsed.references.promptFile, text: null, problem: errorMessage(error) };
    return bundle;
  }
  for (const { reference, label, maxBytes } of paths.documents) {
    const file = await readModeBundleFile(
      modeDir, reference, (label === "promptFile" ? options.maxPromptBytes : options.maxAgentBytes) ?? maxBytes,
    );
    if (file.text === null && !file.problem) file.problem = "not found in the mode directory";
    if (label === "promptFile") bundle.prompt = file;
    else bundle.subagents.push(file);
  }
  bundle.templates = await readTemplates(modeDir, paths.templates);
  return bundle;
}

export type ModeBundleContents = {
  source: string | null;
  problem?: string;
  prompt: string;
  agents: Record<string, string>;
};

export async function readModeBundle(
  modeDir: string,
  options: { maxPromptBytes?: number; maxAgentBytes?: number } = {},
): Promise<ModeBundleContents> {
  const bundle = await readUserModeBundle(modeDir, options);
  const agents = Object.fromEntries(bundle.subagents.flatMap((file) => file.text === null ? [] : [[file.path, file.text]]));
  return { source: bundle.source, ...(bundle.problem ? { problem: bundle.problem } : {}), prompt: bundle.prompt?.text ?? "", agents };
}

type FileTarget = { reference: string; path: string; before: Stats | undefined };

async function inspectTarget(modeDir: string, reference: string): Promise<FileTarget> {
  const path = referencePath(modeDir, reference);
  try {
    return { reference, path, before: await inspectModeFile(path) };
  } catch (error) {
    throw invalid(`${reference}: ${errorMessage(error)}`);
  }
}

async function assertUnchanged(target: FileTarget): Promise<void> {
  const current = await inspectModeFile(target.path);
  if (current && target.before && sameVersion(current, target.before)) return;
  if (current || target.before) throw invalid(`${target.reference}: changed since it was checked`);
}

/** Replace only a checked file. Open new files exclusively so a late arrival cannot be clobbered. */
async function writeModeFile(target: FileTarget, content: string | Buffer, mode = 0o666): Promise<FileTarget> {
  await assertUnchanged(target);
  const parent = dirname(target.path);
  await mkdir(parent, { recursive: true });
  const parentInfo = await inspectModeDirectory(parent);
  if (!parentInfo) throw invalid(`${target.reference}: parent directory disappeared`);
  const stagedPath = target.before ? join(parent, `.${randomUUID()}.tmp`) : target.path;
  const handle = await open(stagedPath, "wx", (target.before?.mode ?? mode) & 0o777);
  let written: Stats | undefined;
  try {
    try {
      written = await handle.stat();
      const currentParent = await inspectModeDirectory(parent);
      if (!currentParent || !sameEntry(parentInfo, currentParent)) throw invalid(`${target.reference}: parent directory changed`);
      await handle.writeFile(content);
      written = await handle.stat();
    } finally {
      await handle.close();
    }
    if (target.before) {
      await assertUnchanged(target);
      await rename(stagedPath, target.path);
    }
    return { ...target, before: written };
  } catch (error) {
    if (written && await inspectModeDirectory(parent)) {
      const current = await statIfPresent(stagedPath);
      if (current && sameEntry(current, written)) await unlink(stagedPath);
    }
    throw error;
  }
}

async function unlinkChecked(target: FileTarget): Promise<void> {
  await assertUnchanged(target);
  if (target.before) await unlink(target.path);
}

/** Write referenced documents first, and replace only files the previous manifest owned. */
export async function writeModeBundle(
  modeDir: string,
  contents: { source: string; prompt: string; agents: Record<string, string> },
  allowExisting = true,
): Promise<void> {
  if (Buffer.byteLength(contents.source) > MODE_LIMITS.fileBytes) {
    throw invalid(`mode.yaml is larger than ${MODE_LIMITS.fileBytes} bytes`);
  }
  const { documents, templates } = documentPaths(readModeBundleReferences(contents.source));
  const subagents = new Set(documents.slice(1).map(({ reference }) => reference));
  for (const reference of Object.keys(contents.agents)) {
    if (!subagents.has(reference)) throw invalid(`subagents: "${reference}" is not declared in mode.yaml`);
  }

  const manifest = await inspectTarget(modeDir, MODE_BUNDLE_FILE);
  const legacy = await inspectTarget(modeDir, MODE_DOCUMENT_FILE);
  if (!allowExisting && (manifest.before || legacy.before)) throw invalid("the directory already has a mode document");
  const previous = manifest.before ? await readModeBytes(manifest.path, MODE_LIMITS.fileBytes) : undefined;
  if (manifest.before && (!previous || !sameVersion(manifest.before, previous.info))) {
    throw invalid("mode.yaml changed while being checked");
  }
  const previousPaths = previous ? readModeBundleReferences(previous.bytes.toString("utf8")) : undefined;
  // An invalid manifest cannot establish ownership, but replacing it can repair
  // the mode as long as the write does not replace any of its existing files.
  const ownedPaths = new Set(previousPaths?.ok ? [previousPaths.references.promptFile, ...previousPaths.references.subagents] : []);
  const targets: { target: FileTarget; text: string }[] = [];
  for (const { reference, label, maxBytes } of documents) {
    const text = label === "promptFile" ? contents.prompt : Object.hasOwn(contents.agents, reference) ? contents.agents[reference] : undefined;
    if (text === undefined) throw invalid(`${label}: no content for "${reference}"`);
    if (Buffer.byteLength(text) > maxBytes) {
      throw invalid(`${label}: "${reference}" is larger than ${maxBytes} bytes`);
    }
    const target = await inspectTarget(modeDir, reference);
    if (target.before && !ownedPaths.has(reference)) throw invalid(`${reference}: would overwrite an unmanaged file`);
    targets.push({ target, text });
  }
  for (const reference of templates) {
    const template = await inspectTarget(modeDir, reference);
    if (!template.before) throw invalid(`${reference}: not found in the mode directory`);
    if (template.before.size > MODE_LIMITS.fileBytes) throw invalid(`${reference}: larger than ${MODE_LIMITS.fileBytes} bytes`);
  }
  await assertUnchanged(manifest);
  await assertUnchanged(legacy);
  for (const { target, text } of targets) await writeModeFile(target, text);
  await writeModeFile(manifest, contents.source);
  // While the old document is removed, the new one already shadows it.
  await unlinkChecked(legacy);
}

export async function writeLegacyMode(modeDir: string, source: string, allowExisting: boolean): Promise<void> {
  const manifest = await inspectTarget(modeDir, MODE_BUNDLE_FILE);
  if (manifest.before) throw invalid("mode.yaml already defines this mode; edit the bundle instead");
  const legacy = await inspectTarget(modeDir, MODE_DOCUMENT_FILE);
  if (legacy.before && !allowExisting) throw invalid("the directory already has a mode document");
  await writeModeFile(legacy, source);
}

async function requiredFile(modeDir: string, reference: string, maxBytes: number): Promise<{ bytes: Buffer; info: Stats }> {
  const path = referencePath(modeDir, reference);
  try {
    const file = await readModeBytes(path, maxBytes);
    if (!file) throw invalid("not found in the mode directory");
    return file;
  } catch (error) {
    throw invalid(`${reference}: ${errorMessage(error)}`);
  }
}

/** Walk resources only under a discovered skill folder, in a bounded, link-free tree. */
async function addSkillFiles(modeDir: string, add: (reference: string) => Promise<void>): Promise<void> {
  const skillsDir = join(modeDir, MODE_SKILLS_DIR);
  if (!(await inspectModeDirectory(skillsDir))) return;
  let entries = 0;
  async function walk(reference: string): Promise<void> {
    const dir = referencePath(modeDir, reference);
    if (!(await inspectModeDirectory(dir))) throw invalid(`${reference}: skill directory disappeared`);
    for await (const entry of await opendir(dir)) {
      if (++entries > MODE_LIMITS.bundleFiles) throw invalid(`skill folders have more than ${MODE_LIMITS.bundleFiles} entries`);
      if (entry.name.startsWith(".")) continue;
      const child = `${reference}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else await add(child); // The same checked read rejects symlinks, hardlinks and special files.
    }
  }
  for (const skill of await discoverModeSkills(skillsDir)) {
    await add(skill.reference);
    if (skill.reference.split("/").length > 2) {
      await walk(skill.reference.slice(0, skill.reference.lastIndexOf("/")));
    }
  }
}

/** Copy references, declared templates and discovered skills, never merging with another directory. */
export async function copyModeBundle(fromDir: string, toDir: string): Promise<void> {
  fromDir = resolve(fromDir);
  toDir = resolve(toDir);
  const copyId = basename(toDir);
  if (!isModeId(copyId) || isInsideDirectory(fromDir, toDir)) throw invalid("the copy needs a different mode directory");
  // Check the dormant entry too, but never read or copy its contents.
  const legacy = await inspectTarget(fromDir, MODE_DOCUMENT_FILE);
  const manifest = await inspectTarget(fromDir, MODE_BUNDLE_FILE);
  if (!manifest.before) throw bundleError("MODE_NOT_FOUND", "the source mode has no mode.yaml bundle");
  const file = await requiredFile(fromDir, MODE_BUNDLE_FILE, MODE_LIMITS.fileBytes);
  if (!sameVersion(manifest.before, file.info)) throw invalid("mode.yaml changed while being checked");
  const source = file.bytes.toString("utf8");
  const { documents, templates } = documentPaths(readModeBundleReferences(source));
  const parent = dirname(toDir);
  if (!(await inspectModeDirectory(parent))) throw invalid("the destination parent directory does not exist");
  if (await statIfPresent(toDir)) throw bundleError("MODE_ALREADY_EXISTS", `the destination "${copyId}" already exists`);

  const renamed = renameModeBundle(source, copyId);
  const parsed = readModeBundleReferences(renamed);
  if (!parsed.ok || (parsed.frontmatter.name !== undefined && parsed.frontmatter.name !== copyId)) {
    throw invalid("mode.yaml: could not rename the copy");
  }
  const renamedBytes = Buffer.from(renamed);
  if (renamedBytes.length > MODE_LIMITS.fileBytes) throw invalid("the renamed manifest is too large");
  const plan = new Map<string, { bytes: Buffer; mode: number }>();
  let totalBytes = renamedBytes.length;
  async function add(reference: string, maxBytes = MODE_LIMITS.bundleBytes): Promise<void> {
    if (plan.has(reference)) return;
    if (plan.size + 1 >= MODE_LIMITS.bundleFiles) {
      throw invalid(`the mode has more than ${MODE_LIMITS.bundleFiles} files`);
    }
    const file = await requiredFile(fromDir, reference, Math.min(maxBytes, MODE_LIMITS.bundleBytes - totalBytes));
    totalBytes += file.bytes.length;
    plan.set(reference, { bytes: file.bytes, mode: file.info.mode });
  }
  for (const { reference, maxBytes } of documents) await add(reference, maxBytes);
  for (const reference of templates) await add(reference, MODE_LIMITS.fileBytes);

  function textOf(reference: string): string {
    const planned = plan.get(reference);
    if (!planned) throw invalid(`${reference}: not found in the copy plan`);
    return planned.bytes.toString("utf8");
  }
  const [prompt, ...subagents] = documents;
  const copied = parseModeBundle({
    references: parsed.references,
    frontmatter: parsed.frontmatter,
    prompt: { path: prompt.reference, text: textOf(prompt.reference) },
    subagents: subagents.map(({ reference }) => ({ path: reference, text: textOf(reference) })),
    templates: Object.fromEntries(templates.map((reference) => [reference, textOf(reference)])),
    source: "user",
    fallbackName: copyId,
  });
  if (!copied.ok) {
    throw bundleError("MODE_DEFINITION_INVALID", copied.errors[0] ?? "invalid mode bundle", { errors: copied.errors });
  }

  await addSkillFiles(fromDir, add);
  plan.set(MODE_BUNDLE_FILE, { bytes: renamedBytes, mode: file.info.mode });

  // Reserve the destination with an exclusive mkdir. Publish the manifest last;
  // on failure roll back only files that this copy created, not concurrent additions.
  await assertUnchanged(manifest);
  await assertUnchanged(legacy);
  if (!(await inspectModeDirectory(parent))) throw invalid("the destination parent directory disappeared");
  try {
    await mkdir(toDir);
  } catch (error) {
    if (code(error) === "EEXIST") throw bundleError("MODE_ALREADY_EXISTS", `the destination "${copyId}" already exists`);
    throw error;
  }
  const written: FileTarget[] = [];
  try {
    for (const [reference, { bytes, mode }] of plan) {
      const target = { reference, path: referencePath(toDir, reference), before: undefined };
      written.push(await writeModeFile(target, bytes, mode));
    }
  } catch (error) {
    try {
      for (const target of written.reverse()) {
        await unlinkChecked(target);
        await pruneEmptyParents(toDir, target.path);
      }
      await removeIfEmpty(toDir);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `mode copy failed: ${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

/** Preflight every managed path before unlinking; remove a legacy shadow before mode.yaml. */
export async function removeModeFiles(modeDir: string): Promise<boolean> {
  const manifest = await inspectTarget(modeDir, MODE_BUNDLE_FILE);
  const legacy = await inspectTarget(modeDir, MODE_DOCUMENT_FILE);
  const targets: FileTarget[] = [];
  if (manifest.before || legacy.before) {
    const entry = manifest.before ? manifest : legacy;
    const { bytes, info } = await requiredFile(modeDir, entry.reference, MODE_LIMITS.fileBytes);
    if (!entry.before || !sameVersion(entry.before, info)) throw invalid(`${entry.reference}: changed while being checked`);
    const source = bytes.toString("utf8");
    const paths = manifest.before
      ? documentPaths(readModeBundleReferences(source))
      : { documents: [], templates: templateReferences(legacyFrontmatter(source)) };
    const references = [...paths.documents.map(({ reference }) => reference), ...paths.templates];
    for (const reference of references) {
      const target = await inspectTarget(modeDir, reference);
      const info = target.before;
      if (!info) throw invalid(`${reference}: not found in the mode directory`);
      if (targets.some(({ before }) => before !== undefined && sameEntry(before, info))) {
        throw invalid(`${reference}: aliases another managed file`);
      }
      targets.push(target);
    }
    await assertUnchanged(manifest);
    await assertUnchanged(legacy);
    for (const target of targets) await unlinkChecked(target);
    await unlinkChecked(legacy);
    await unlinkChecked(manifest);
    for (const target of targets) await pruneEmptyParents(modeDir, target.path);
  }
  return removeIfEmpty(modeDir);
}

async function removeIfEmpty(path: string): Promise<boolean> {
  if (!(await inspectModeDirectory(path))) return true;
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return true;
    if (code(error) === "ENOTEMPTY" || code(error) === "EEXIST") return false;
    throw error;
  }
}

async function pruneEmptyParents(modeDir: string, filePath: string): Promise<void> {
  const root = resolve(modeDir);
  for (let current = dirname(resolve(filePath)); current !== root && isInsideDirectory(root, current); current = dirname(current)) {
    if (!(await removeIfEmpty(current))) return;
  }
}

/** The user owns the skills tree; return a safe path and create it only on demand. */
export async function modeSkillsDirectory(modeDir: string, create: boolean): Promise<string> {
  const target = join(modeDir, MODE_SKILLS_DIR);
  const parent = await inspectModeDirectory(modeDir);
  const info = parent ? await statIfPresent(target) : undefined;
  if (info?.isSymbolicLink()) {
    throw bundleError("MODE_SKILLS_LINKED", "the skills directory is a symbolic link; replace it with a real directory");
  }
  if (info && !info.isDirectory()) throw bundleError("MODE_SKILLS_NOT_DIRECTORY", "the skills path is not a directory");
  if (!info && create) {
    await mkdir(target, { recursive: true });
    if (!(await inspectModeDirectory(target))) throw invalid("the skills directory disappeared");
  }
  return target;
}

/** A `mode.yaml` for a new mode, so creation never starts from a stale shape. */
export function newModeBundleSource(input: {
  id: string;
  label?: string;
  description?: string;
  permission?: "agent" | "contract";
  promptFile: string;
  subagents?: string[];
  includeGlobalSubagents?: boolean;
}): string {
  const lines = [`name: ${input.id}`];
  if (input.label) lines.push(`label: ${input.label}`);
  if (input.description) lines.push(`description: ${input.description}`);
  if (input.permission) lines.push(`permission: ${input.permission}`);
  lines.push(`promptFile: ${input.promptFile}`);
  if (input.subagents?.length) {
    lines.push("subagents:");
    for (const reference of input.subagents) lines.push(`  - ${reference}`);
  }
  if (input.includeGlobalSubagents !== undefined) {
    lines.push(`includeGlobalSubagents: ${input.includeGlobalSubagents}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The fields of a bundle a summary needs, without a parsed definition. */
export type ModeBundleSummary = Pick<ModeDefinition, "id" | "label" | "description" | "permission">;
