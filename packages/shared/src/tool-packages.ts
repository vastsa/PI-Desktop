/**
 * Bundled tool packages (D681).
 *
 * A tool package is a directory under the build's `resources/tools` with a
 * `tool.json` manifest. The host scans that directory and owns the enabled set
 * (`<data_dir>/tools/state.json`), so the renderer only ever sees a summary and
 * asks for one toggle — it never reads the filesystem.
 */

/** One tool a package declares. Mirrors the plugin `contributes.agentTools` shape. */
export type ToolPackageTool = {
  name: string;
  description: string;
  risk?: "low" | "medium" | "high";
};

/** One package as the host reports it. */
export type ToolPackageSummary = {
  /** Manifest id; falls back to the directory name for a package that cannot be read. */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Directory under `resources/tools` the package was read from. */
  dirName: string;
  enabled: boolean;
  tools: ToolPackageTool[];
  /** Why the manifest could not be read, when it could not. The row still renders. */
  error?: string;
};
