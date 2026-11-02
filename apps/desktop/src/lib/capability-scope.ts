import type { AgentCapabilityLevel, AgentCapabilityQuery } from "@pi-desktop/shared";

/**
 * The query a capability request carries for one row of its own level.
 *
 * A global row's switch reads and writes the global default, so its query must
 * stay scope-free even when a project is selected: appending the selection
 * would write a per-project override while the switch still reads as global,
 * and a reader with a legacy override under one project could then never turn
 * the global default off from there (#1957). Project rows are the one case
 * that needs the path - the host resolves a project definition through that
 * project's directory, so without it the row cannot be found at all.
 */
export function capabilityQuery(
  level: AgentCapabilityLevel,
  selectedProjectPath: string | null,
): AgentCapabilityQuery {
  return {
    level,
    ...(level === "project" && selectedProjectPath
      ? { projectPath: selectedProjectPath }
      : {}),
  };
}

/** A global row carries a stored override for the selected project. */
export type CapabilityOverride = "on" | "off";

/**
 * Per-row direction of a stored per-project override on a global row.
 *
 * The scope-free global list reports the global default while the
 * project-scoped query reports effective state (`enabled()` gives a stored
 * override precedence), so a row whose effective toggle differs from the
 * default has an override underneath. The difference is surfaced, not hidden:
 * a stale override written by the old UI stays runtime-authoritative for its
 * project until the reader resets the row (#1957).
 */
export function deriveProjectOverrides(
  defaults: readonly { id: string; enabled: boolean }[],
  effective: readonly { id: string; enabled: boolean }[],
): Map<string, CapabilityOverride> {
  const effectiveById = new Map(effective.map((row) => [row.id, row.enabled]));
  const overrides = new Map<string, CapabilityOverride>();
  for (const row of defaults) {
    const effectiveEnabled = effectiveById.get(row.id);
    if (effectiveEnabled === undefined || effectiveEnabled === row.enabled) continue;
    overrides.set(row.id, effectiveEnabled ? "on" : "off");
  }
  return overrides;
}
