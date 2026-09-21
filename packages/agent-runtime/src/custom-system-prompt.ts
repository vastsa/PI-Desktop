/**
 * pi-compatible custom system prompt files (issue #542).
 *
 * pi CLI honors `SYSTEM.md` (replace the default persona) and
 * `APPEND_SYSTEM.md` (append to it) in two locations, discovered
 * independently and each picked as a single winner — project before global:
 *
 * - `<workspace>/.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` (project)
 * - `~/.pi/agent/SYSTEM.md` / `~/.pi/agent/APPEND_SYSTEM.md` (global)
 *
 * PI-Desktop follows the same discovery and precedence. One deliberate
 * deviation, recorded in spec 03-runtime/02-agent-runtime.md §7: replacing
 * the default prompt here means replacing only the product persona block;
 * the runtime's operational rules (tool guidance, collaboration, scratch
 * and delegation mechanics) always stay in the composed prompt, so desktop
 * features keep working under a custom persona. `APPEND_SYSTEM.md` is
 * appended after the composed base prompt and before project instructions,
 * so the user's own AGENTS.md chain keeps the last word, matching pi's
 * ordering.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_PROMPT_BYTES = 64 * 1024;

export type CustomSystemPrompt = {
  /** Resolved `SYSTEM.md` content, when a file was found. */
  replace?: string;
  /** Resolved `APPEND_SYSTEM.md` content, when a file was found. */
  append?: string;
};

export type CustomSystemPromptDirs = {
  project?: string;
  global: string;
};

export function customSystemPromptDirs(
  workspaceRoot: string | null | undefined,
): CustomSystemPromptDirs {
  return {
    ...(workspaceRoot?.trim() ? { project: join(workspaceRoot.trim(), ".pi") } : {}),
    global: join(homedir(), ".pi", "agent"),
  };
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

/** Project wins over global; a whitespace-only file counts as absent. */
async function readFirst(
  dirs: CustomSystemPromptDirs,
  fileName: string,
): Promise<string | undefined> {
  for (const dir of [dirs.project, dirs.global]) {
    if (!dir) continue;
    try {
      const content = (await readFile(join(dir, fileName), "utf8")).trim();
      if (content) return limitUtf8(content, MAX_PROMPT_BYTES);
    } catch {
      // Missing or unreadable files are an expected state; fall through.
    }
  }
  return undefined;
}

export async function loadCustomSystemPrompt(
  workspaceRoot: string | null | undefined,
  dirs?: CustomSystemPromptDirs,
): Promise<CustomSystemPrompt | undefined> {
  const resolved = dirs ?? customSystemPromptDirs(workspaceRoot);
  const replace = await readFirst(resolved, "SYSTEM.md");
  const append = await readFirst(resolved, "APPEND_SYSTEM.md");
  return replace || append ? { ...(replace ? { replace } : {}), ...(append ? { append } : {}) } : undefined;
}
