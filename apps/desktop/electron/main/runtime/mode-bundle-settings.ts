/**
 * Mode-level settings on a `mode.yaml` bundle (issue #2544 §2, §3).
 *
 * The settings page edits exactly two mode-level decisions: whether the mode's
 * own role list is the whole catalog (`includeGlobalSubagents`) and which of the
 * mode's private skills are switched off (`disabledSkills`). Neither is a
 * reference, so neither can move a document: the two keys are rewritten in
 * place and everything else in `mode.yaml` — stages, artifacts, budget, the
 * role list itself — is left byte-for-byte as the user wrote it.
 *
 * Rewriting text rather than re-serializing a parsed value is deliberate. A
 * `mode.yaml` may carry nested stage maps the renderer never models; a
 * round-trip through a serializer would rewrite them and could change their
 * meaning. The edit here only replaces the two top-level keys it owns, and
 * `writeModeBundle` then re-parses the result before anything reaches disk, so
 * an edit that would corrupt the map is refused, not saved.
 *
 * A legacy `mode.md` mode has no bundle, so both decisions are absent there by
 * construction: `readBundle` reports it and the page keeps offering only the
 * document editor that already existed.
 */
import { stat } from "node:fs/promises";
import { MODE_SKILL_ID_RE, type ModeCatalog, type ModeSkillSummary } from "@pi-desktop/shared";
import type { ModeCatalogService } from "./mode-catalog";
import { listModeSkills } from "./mode-skills";

/** The two mode-level keys this module owns. */
export type ModeBundleSettingsPatch = {
  includeGlobalSubagents?: boolean;
  disabledSkills?: string[];
};

/** Keys the settings page may write; used to reject an empty patch. */
export function hasBundleSettingsPatch(patch: ModeBundleSettingsPatch): boolean {
  return patch.includeGlobalSubagents !== undefined || patch.disabledSkills !== undefined;
}

function settingError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/** A top-level `key:` line: no indentation, so a nested key never matches. */
function topLevelKeyIndex(lines: string[], key: string): number {
  const pattern = new RegExp(`^${key}\\s*:`);
  return lines.findIndex((line) => pattern.test(line));
}

/**
 * Lines that belong to a block value under `keyIndex`: the indented items (and
 * their own continuation lines) that follow the key.
 */
function blockEnd(lines: string[], keyIndex: number): number {
  let end = keyIndex + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  return end;
}

/**
 * Rewrite `disabledSkills` / `includeGlobalSubagents` in a `mode.yaml` source.
 *
 * Values are written in the canonical block form the loader documents, and a
 * key whose new value is empty is removed rather than left as `key: []`, so the
 * file keeps reading the way its author would have written it.
 */
export function applyModeBundleSettings(source: string, patch: ModeBundleSettingsPatch): string {
  // Trailing blank lines are normalized away by the join at the end, so the
  // final newline is added once there rather than preserved from the input.
  let lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);

  if (patch.includeGlobalSubagents !== undefined) {
    const line = `includeGlobalSubagents: ${patch.includeGlobalSubagents}`;
    const index = topLevelKeyIndex(lines, "includeGlobalSubagents");
    if (index === -1) lines.push(line);
    else lines[index] = line;
  }

  if (patch.disabledSkills !== undefined) {
    const ids: string[] = [];
    for (const id of patch.disabledSkills) {
      if (typeof id !== "string") throw settingError("INVALID_ARGUMENT", "disabledSkills accepts skill ids");
      const trimmed = id.trim();
      if (!MODE_SKILL_ID_RE.test(trimmed)) {
        throw settingError("INVALID_ARGUMENT", `disabledSkills: "${trimmed}" is not a skill id`);
      }
      if (ids.includes(trimmed)) {
        throw settingError("INVALID_ARGUMENT", `disabledSkills: "${trimmed}" is listed twice`);
      }
      ids.push(trimmed);
    }
    const index = topLevelKeyIndex(lines, "disabledSkills");
    const replacement = ids.length ? ["disabledSkills:", ...ids.map((id) => `  - ${id}`)] : [];
    if (index === -1) {
      lines.push(...replacement);
    } else {
      lines = [...lines.slice(0, index), ...replacement, ...lines.slice(blockEnd(lines, index))];
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** What the settings page shows on the skills tab. */
export type ModeSkillsState = {
  modeId: string;
  directory: string;
  /** False until the mode's own `skills/` folder has been created. */
  exists: boolean;
  skills: ModeSkillSummary[];
};

async function directoryExists(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info?.isDirectory() === true;
}

/**
 * The mode's `skills/` folder and its discovered skills.
 *
 * The path always comes from the catalog, never from the renderer, so a mode id
 * that no longer loads cannot be used to address another directory. A missing
 * folder is reported as absent instead of being created by a read: the user
 * asked to look, not to write.
 */
export async function readModeSkillsState(
  catalog: ModeCatalogService,
  modeId: string,
): Promise<ModeSkillsState> {
  const directory = await catalog.skillsDirectory(modeId, false);
  const exists = await directoryExists(directory);
  return {
    modeId,
    directory,
    exists,
    skills: exists ? await listModeSkills(catalog, modeId) : [],
  };
}

/**
 * Open the mode's `skills/` folder through the host's trusted shell, creating
 * it first when it is absent so the user has somewhere to drop a skill.
 *
 * `openPath` is injected: this module never imports Electron, and the path
 * handed to the OS is the one the catalog derived.
 */
export async function openModeSkillsDirectory(
  catalog: ModeCatalogService,
  modeId: string,
  openPath: (path: string) => Promise<string>,
): Promise<{ directory: string }> {
  const directory = await catalog.skillsDirectory(modeId, true);
  const failure = await openPath(directory);
  if (failure) {
    throw settingError("MODE_SKILLS_OPEN_FAILED", `The skills folder could not be opened: ${failure}`);
  }
  return { directory };
}

/**
 * Apply a mode-level patch and save the bundle.
 *
 * The rest of the bundle is passed through unchanged, so the prompt and every
 * private role document keep their content; a patch that leaves the file as it
 * was returns the freshly read catalog without writing.
 */
export async function saveModeBundleSettings(
  catalog: ModeCatalogService,
  modeId: string,
  patch: ModeBundleSettingsPatch,
): Promise<ModeCatalog> {
  if (!hasBundleSettingsPatch(patch)) {
    throw settingError("INVALID_ARGUMENT", "nothing to update");
  }
  const bundle = await catalog.readBundle(modeId);
  const source = applyModeBundleSettings(bundle.source, patch);
  if (source === bundle.source) return catalog.catalog();
  return catalog.writeBundle(modeId, {
    source,
    prompt: bundle.prompt,
    agents: bundle.agents,
  });
}
