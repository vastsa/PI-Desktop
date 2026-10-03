import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const INSTRUCTION_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  join(".claude", "CLAUDE.md"),
];
const MAX_INSTRUCTION_BYTES = 32 * 1024;
const GLOBAL_INSTRUCTION_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

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

function limitUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return content.slice(0, end);
}

async function readInstruction(
  workspaceRoot: string,
  canonicalWorkspaceRoot: string,
  directory: string,
  remaining: number,
): Promise<ProjectInstruction | undefined> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    try {
      const file = join(directory, name);
      const canonicalFile = await realpath(file);
      if (!isWithinRoot(canonicalWorkspaceRoot, canonicalFile)) continue;
      const content = (await readFile(file, "utf8")).trim();
      if (!content) continue;
      return {
        source: normalizeStablePath(relative(workspaceRoot, file) || name),
        content: limitUtf8(content, remaining),
      };
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
  maxBytes = MAX_INSTRUCTION_BYTES,
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
    const entry = await readInstruction(root, canonicalRoot, directory, remaining);
    if (!entry) continue;
    entries.push(entry);
    remaining -= Buffer.byteLength(entry.content, "utf8");
  }
  return entries.length > 0 ? { entries } : undefined;
}

/** Build the complete chain: global defaults precede project instructions. */
export async function loadInstructionChain(
  workspaceRoot: string | null | undefined,
  workspacePath?: string,
  globalPath = GLOBAL_INSTRUCTION_PATH,
): Promise<ProjectInstructions | undefined> {
  const entries: ProjectInstruction[] = [];
  let remaining = MAX_INSTRUCTION_BYTES;
  try {
    const content = (await readFile(globalPath, "utf8")).trim();
    if (content) {
      const limited = limitUtf8(content, remaining);
      entries.push({ source: "~/.pi/agent/AGENTS.md", content: limited });
      remaining -= Buffer.byteLength(limited, "utf8");
    }
  } catch {
    // A missing global file is an expected first-run state.
  }
  const project = await loadProjectInstructions(
    workspaceRoot,
    workspacePath,
    remaining,
  );
  return entries.length || project?.entries.length
    ? { entries: [...entries, ...(project?.entries ?? [])] }
    : undefined;
}
