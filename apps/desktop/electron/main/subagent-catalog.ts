/**
 * The effective delegation catalog, read once and shared.
 *
 * The `Task` tool is registered from `loadSubagentDefinitions`, and the
 * settings page lists the very same list through `subagent/catalog`. The
 * composer needs it too, to offer `@agent` in its autocomplete. Three
 * consumers of one merge rule means the merge lives here rather than being
 * repeated per IPC surface: a menu that offered an agent `Task` would refuse,
 * or vice versa, is the bug this prevents.
 */
import type { SubagentDefinition } from "@pi-desktop/shared";
import {
  loadSubagentDefinitions,
  type UserSubagentDocument,
} from "@pi-desktop/agent-runtime";

export type SubagentCatalog = {
  /** The delegates `Task` will actually accept, keyed as the IPC returns them. */
  subagents: SubagentDefinition[];
  /** Shipped definitions, including any the user switched off. */
  builtins: Array<SubagentDefinition & { enabled: boolean }>;
  diagnostics: unknown;
  projectPath: string | null;
};

export type SubagentCatalogLoader = (
  projectPath: string | undefined,
) => Promise<SubagentCatalog>;

/**
 * Build the catalog loader shared by the catalog IPC, the composer command
 * service and the prompt path.
 *
 * `builtins` carries a switched-off builtin with `enabled: false` so the
 * settings page can keep its row and let the user turn it back on. A disabled
 * builtin is never a delegation candidate, so the composer's agent list reads
 * `subagents` alone and cannot offer a handle the runtime would reject.
 */
export function createSubagentCatalogLoader({
  activeUserSubagentDocuments,
  disabledBuiltinSubagents,
}: {
  activeUserSubagentDocuments: (
    projectPath: string | undefined,
  ) => Promise<UserSubagentDocument[]>;
  disabledBuiltinSubagents: () => Promise<string[]>;
}): SubagentCatalogLoader {
  return async (projectPath) => {
    const disabled = await disabledBuiltinSubagents();
    const { definitions, builtins, diagnostics } = await loadSubagentDefinitions(
      projectPath,
      {
        userDocuments: await activeUserSubagentDocuments(projectPath),
        disabledBuiltins: disabled,
      },
    );
    const off = new Set(disabled);
    return {
      subagents: definitions,
      builtins: builtins.map((definition) => ({
        ...definition,
        enabled: !off.has(definition.name),
      })),
      diagnostics,
      projectPath: projectPath ?? null,
    };
  };
}
