import type { loadSubagentDefinitions } from "@pi-desktop/agent-runtime";
import type { ModeDefinition } from "@pi-desktop/shared";
import type { ModeCatalogService } from "./mode-catalog";

/** Resolve fresh role policy at the parent turn/menu boundary. Never consult a
 * project directory for a mode and never substitute globals for a missing mode. */
export async function currentModeBundle(catalog: ModeCatalogService, mode: string) {
  await catalog.refresh();
  const definition = await catalog.definition(mode);
  if (!definition) throw new Error(`Mode "${mode}" is not available`);
  return definition.bundle;
}

export async function sessionSubagents(
  bundle: ModeDefinition["bundle"],
  loadGlobals: () => ReturnType<typeof loadSubagentDefinitions>,
  mode: string,
) {
  if (!bundle) return loadGlobals();
  const definitions = bundle.subagents.map(role => ({ ...role, modeOwner: mode }));
  const globals = bundle.includeGlobalSubagents ? await loadGlobals() : undefined;
  const names = new Set(definitions.map(role => role.name));
  return {
    definitions: [...definitions, ...(globals?.definitions.filter(role => !names.has(role.name)) ?? [])]
      .map(role => ({ ...role, catalogMode: mode })),
    builtins: globals?.builtins.filter(role => !names.has(role.name)) ?? [],
    diagnostics: globals?.diagnostics ?? [],
  };
}
