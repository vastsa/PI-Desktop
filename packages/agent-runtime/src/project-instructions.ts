import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const INSTRUCTION_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  join(".claude", "CLAUDE.md"),
];
// The global file and the project chain have independent budgets so an
// oversized global file can never starve project instructions.
const MAX_GLOBAL_INSTRUCTION_BYTES = 32 * 1024;
const MAX_PROJECT_INSTRUCTION_BYTES = 32 * 1024;
const GLOBAL_INSTRUCTION_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");
const GLOBAL_INSTRUCTION_SOURCE = "~/.pi/agent/AGENTS.md";

export type ProjectInstruction = {
  source: string;
  content: string;
};

export type ProjectInstructions = {
  entries: ProjectInstruction[];
};

export function globalInstructionPath(): string {
  return GLOBAL_INSTRUCTION_PATH;
}

function isWithinRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function normalizeStablePath(path: string): string {
  return path.replace(/\\/g, "/");
}

type LimitedInstruction = {
  entry: ProjectInstruction;
  /** UTF-8 bytes of file content kept, excluding any truncation notice. */
  bytes: number;
  truncated: boolean;
};

/**
 * Keep at most `maxBytes` of UTF-8 content without splitting a character.
 * A cut is never silent: the kept text is followed by a notice naming the
 * source and the kept/total byte counts, so the model can tell the file is
 * incomplete.
 */
function limitInstruction(
  source: string,
  content: string,
  maxBytes: number,
): LimitedInstruction {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= maxBytes) {
    return { entry: { source, content }, bytes: totalBytes, truncated: false };
  }
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  const notice = `[PI-Desktop truncated ${source}: loaded the first ${bytes} of ${totalBytes} bytes; the rest of this file is not in context.]`;
  const kept = content.slice(0, end).trimEnd();
  return {
    entry: { source, content: kept ? `${kept}\n\n${notice}` : notice },
    bytes,
    truncated: true,
  };
}

async function readInstruction(
  workspaceRoot: string,
  canonicalWorkspaceRoot: string,
  directory: string,
  remaining: number,
): Promise<LimitedInstruction | undefined> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    try {
      const file = join(directory, name);
      const canonicalFile = await realpath(file);
      if (!isWithinRoot(canonicalWorkspaceRoot, canonicalFile)) continue;
      const content = (await readFile(file, "utf8")).trim();
      if (!content) continue;
      return limitInstruction(
        normalizeStablePath(relative(workspaceRoot, file) || name),
        content,
        remaining,
      );
    } catch {
      // Try the next recognized name or the next directory.
    }
  }
  return undefined;
}

/**
 * Resolve project instructions from the workspace root to a workspace path.
 * Each directory contributes at most one file: AGENTS.override.md takes
 * precedence over AGENTS.md. The returned order gives nested files the last
 * word, matching Codex's project instruction chain.
 */
export async function loadProjectInstructions(
  workspaceRoot: string | null | undefined,
  workspacePath?: string,
  maxBytes = MAX_PROJECT_INSTRUCTION_BYTES,
): Promise<ProjectInstructions | undefined> {
  if (!workspaceRoot?.trim()) return undefined;

  const root = resolve(workspaceRoot);
  const canonicalRoot = await realpath(root).catch(() => root);
  const target = workspacePath?.trim()
    ? resolve(root, workspacePath)
    : root;
  // Instructions are never read from outside the project. A target outside the
  // root, or the root itself (whose parent lies outside), keeps the root's own
  // chain instead of dropping every project instruction.
  const targetDirectory =
    isWithinRoot(root, target) && target !== root ? dirname(target) : root;
  const directories: string[] = [];
  for (let current = targetDirectory; ; current = dirname(current)) {
    directories.unshift(current);
    if (current === root) break;
  }

  const entries: ProjectInstruction[] = [];
  let remaining = Math.max(0, maxBytes);
  for (const directory of directories) {
    if (remaining <= 0) break;
    const loaded = await readInstruction(root, canonicalRoot, directory, remaining);
    if (!loaded) continue;
    entries.push(loaded.entry);
    // A truncated file has used up the budget; closer files are not loaded.
    if (loaded.truncated) break;
    remaining -= loaded.bytes;
  }
  return entries.length > 0 ? { entries } : undefined;
}

/**
 * Build the complete chain: global defaults precede project instructions.
 * The global file and the project chain are capped independently.
 */
export async function loadInstructionChain(
  workspaceRoot: string | null | undefined,
  workspacePath?: string,
  globalPath = GLOBAL_INSTRUCTION_PATH,
): Promise<ProjectInstructions | undefined> {
  const entries: ProjectInstruction[] = [];
  try {
    const content = (await readFile(globalPath, "utf8")).trim();
    if (content) {
      entries.push(
        limitInstruction(GLOBAL_INSTRUCTION_SOURCE, content, MAX_GLOBAL_INSTRUCTION_BYTES)
          .entry,
      );
    }
  } catch {
    // A missing global file is an expected first-run state.
  }
  const project = await loadProjectInstructions(workspaceRoot, workspacePath);
  return entries.length || project?.entries.length
    ? { entries: [...entries, ...(project?.entries ?? [])] }
    : undefined;
}
