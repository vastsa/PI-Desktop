import type { ProjectInstructions } from "@pi-desktop/agent-runtime";
import type { WorkspaceFilesRequest } from "@pi-desktop/shared";

const SOURCES = new Set(["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]);

/** Host repository instructions only; local global defaults are supplied separately. */
export async function loadRemoteWorkspaceInstructions(
  files: (hostKey: string, input: WorkspaceFilesRequest) => Promise<unknown>,
  workspace: { hostKey: string; path: string },
  defaults?: ProjectInstructions,
): Promise<ProjectInstructions | undefined> {
  const value = await files(workspace.hostKey, { path: workspace.path, operation: "instructions" });
  const invalid = (): never => {
    throw Object.assign(new Error("Remote Host returned invalid repository instructions"), { errorCode: "INVALID_ARGUMENT" });
  };
  if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries) || value.entries.length > 1) return invalid();
  const entries = value.entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("source" in entry) || !("content" in entry)
      || typeof entry.source !== "string" || !SOURCES.has(entry.source)
      || typeof entry.content !== "string" || Buffer.byteLength(entry.content, "utf8") > 33_280) return invalid();
    return { source: entry.source, content: entry.content };
  });
  const merged = [...(defaults?.entries ?? []), ...entries];
  return merged.length ? { entries: merged } : undefined;
}
