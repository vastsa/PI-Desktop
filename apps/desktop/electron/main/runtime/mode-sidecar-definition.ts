import type { ModeDefinition } from "@pi-desktop/shared";

export type SidecarModeDefinition = Omit<ModeDefinition, "bundle">;

/** Keep bundle metadata in the catalog and Host snapshot. The sidecar gets
 * the resolved subagent and skill catalogs separately from the definition. */
export function toSidecarModeDefinition({ bundle: _bundle, ...definition }: ModeDefinition): SidecarModeDefinition {
  return definition;
}
