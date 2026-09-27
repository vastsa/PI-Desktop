import {
  TEMPLATE_NAMES,
  check,
  isTemplateName,
  pack,
  scaffold,
  type CheckResult,
} from "@pi-desktop/plugin-devkit";
import { resolveWithinRoot } from "./fs-panel";
import type { AgentSidecar, LocalToolResult } from "./agent-sidecar";

/**
 * Plugin authoring tools served by Electron main.
 *
 * They live here rather than in host-core because the devkit, the plugin
 * registry and the dev-plugin loader are all main-process concerns, and the
 * same reason `BrowserPreview` is a local tool applies: no host round-trip
 * needed, and the agent gets the registry's live view.
 */

export type PluginDevToolDeps = {
  /** Absolute workspace root for a session, or null when none is open. */
  resolveWorkspace: (sessionId: string) => Promise<string | null>;
  /** Register the directory as a development plugin and return its grants. */
  registerDevPlugin: (path: string) => Promise<string[] | undefined>;
  /** Start the plugin host process for the directory. */
  loadPlugin: (path: string, permissions?: string[]) => Promise<void>;
};

function failure(content: string): LocalToolResult {
  return { ok: false, isError: true, content };
}

/** Errors and warnings, rendered for a model rather than a terminal. */
function formatCheck(result: CheckResult): string {
  const lines: string[] = [];
  if (result.errors.length) {
    lines.push(`${result.errors.length} error(s):`);
    for (const issue of result.errors) lines.push(`- [${issue.code}] ${issue.message}`);
  }
  if (result.warnings.length) {
    lines.push(`${result.warnings.length} warning(s):`);
    for (const issue of result.warnings) lines.push(`- [${issue.code}] ${issue.message}`);
  }
  return lines.join("\n");
}

/** Resolve a tool-supplied directory against the session workspace. */
async function resolveTarget(
  deps: PluginDevToolDeps,
  sessionId: string,
  toolName: string,
  raw: unknown,
): Promise<{ path: string } | { error: LocalToolResult }> {
  const value = String((raw as { directory?: unknown })?.directory ?? "").trim();
  if (!value) {
    return { error: failure(`${toolName}: \`directory\` is required.`) };
  }
  const root = await deps.resolveWorkspace(sessionId);
  if (!root) {
    return { error: failure(`${toolName}: no workspace is open.`) };
  }
  const resolved = resolveWithinRoot(root, value);
  if (!resolved) {
    return {
      error: failure(
        `${toolName}: "${value}" resolves outside the workspace. Use a path inside the open project.`,
      ),
    };
  }
  return { path: resolved };
}

export function registerPluginDevTools(
  sidecar: Pick<AgentSidecar, "setLocalTool">,
  deps: PluginDevToolDeps,
): void {
  sidecar.setLocalTool("PluginScaffold", async ({ args, sessionId }) => {
    const template = String((args as { template?: unknown })?.template ?? "").trim();
    if (!isTemplateName(template)) {
      return failure(
        `PluginScaffold: \`template\` must be one of ${TEMPLATE_NAMES.join(", ")}.`,
      );
    }
    const target = await resolveTarget(deps, sessionId, "PluginScaffold", args);
    if ("error" in target) return target.error;

    let created;
    try {
      created = await scaffold({
        dir: target.path,
        template,
        id: optionalString((args as { id?: unknown })?.id),
        name: optionalString((args as { name?: unknown })?.name),
      });
    } catch (error) {
      return failure(`PluginScaffold: ${(error as Error).message}`);
    }

    // Load it immediately: the point of scaffolding is a plugin that already
    // runs, so the next edit is a hot reload rather than a first load.
    let loadNote = "";
    try {
      const permissions = await deps.registerDevPlugin(target.path);
      await deps.loadPlugin(target.path, permissions);
      loadNote = " It is loaded as a development plugin and hot-reloads on save.";
    } catch (error) {
      loadNote = ` The files are written, but loading it failed: ${
        (error as Error).message
      }. Fix the plugin and load it from the plugins page.`;
    }

    return {
      ok: true,
      content: [
        `Created ${created.id} (${created.name}) from the ${template} template in ${target.path}.`,
        `Files: ${created.files.join(", ")}.${loadNote}`,
      ].join("\n"),
    };
  });

  sidecar.setLocalTool("PluginCheck", async ({ args, sessionId }) => {
    const target = await resolveTarget(deps, sessionId, "PluginCheck", args);
    if ("error" in target) return target.error;

    let result: CheckResult;
    try {
      result = await check(target.path);
    } catch (error) {
      return failure(`PluginCheck: ${(error as Error).message}`);
    }
    const detail = formatCheck(result);
    if (!result.ok) {
      return failure(`PluginCheck failed for ${target.path}.\n${detail}`);
    }
    return {
      ok: true,
      content: [
        `PluginCheck passed for ${result.manifest?.id ?? target.path}: ${result.fileCount} file(s) would be packaged.`,
        detail || "No warnings.",
      ].join("\n"),
    };
  });

  sidecar.setLocalTool("PluginPack", async ({ args, sessionId }) => {
    const target = await resolveTarget(deps, sessionId, "PluginPack", args);
    if ("error" in target) return target.error;

    try {
      const result = await pack(target.path);
      const warnings = result.check.warnings.length
        ? `\n${formatCheck(result.check)}`
        : "";
      return {
        ok: true,
        content:
          `Packaged ${result.fileName} (${result.byteLength} bytes, ${result.fileCount} files, sha256 ${result.shasum}) at ${result.packagePath}. ` +
          `Install it from the plugins page.${warnings}`,
      };
    } catch (error) {
      return failure(`PluginPack: ${(error as Error).message}`);
    }
  });
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
