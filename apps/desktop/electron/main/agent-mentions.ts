import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findAgentMentions, type AgentMention, type Mode } from "@pi-desktop/shared";

/**
 * Send-time resolution of `@agent` mentions (ADR 0346).
 *
 * A token is a delegation only when the turn runs in Agent mode (the only mode
 * that may execute `Task`), it names a subagent in the catalog this launch
 * hands the runtime, and the workspace holds no file or folder of that name —
 * a project that really has an `explorer` file keeps its file reference.
 */
export async function resolvePromptAgentMentions({
  content,
  mode,
  subagentNames,
  workspaceRoot,
}: {
  content: string;
  mode: Mode | undefined;
  subagentNames: readonly string[];
  /** Local workspace root; `null` for a remote or project-less session. */
  workspaceRoot: string | null;
}): Promise<AgentMention[]> {
  if (mode !== "agent" || subagentNames.length === 0 || !content.includes("@")) return [];
  const mentions = findAgentMentions(content, new Set(subagentNames));
  if (!mentions.length || !workspaceRoot) return mentions;
  const shadowed = new Set<string>();
  for (const name of new Set(mentions.map((mention) => mention.name))) {
    // Catalog names match /^[a-z0-9][a-z0-9-]*$/, so the join stays inside root.
    if (await pathExists(join(workspaceRoot, name))) shadowed.add(name);
  }
  return mentions.filter((mention) => !shadowed.has(mention.name));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
