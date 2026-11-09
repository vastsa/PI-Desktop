import type { BuiltinMode, Mode, ModeCatalog } from "@pi-desktop/shared";
import { MODE_CYCLE, MODE_LABEL_KEYS } from "../chat/composer/model";

/**
 * What the composer mode picker offers (ADR mode-definitions).
 *
 * Builtins keep their localized labels and fixed order; user modes follow as
 * written in their definition. A reserved user document (a builtin id) is
 * never offered, and an unavailable one is listed disabled with its first
 * diagnostic so the user can see why.
 */
export function isBuiltinMode(mode: Mode): mode is BuiltinMode {
  return mode === "agent" || mode === "plan" || mode === "goal";
}

export type UserModePickerEntry = {
  id: string;
  label: string;
  description: string;
  staged: boolean;
  available: boolean;
  /** First diagnostic of an unavailable mode. */
  reason?: string;
};

export function userModePickerEntries(catalog: ModeCatalog | null | undefined): UserModePickerEntry[] {
  if (!catalog) return [];
  return catalog.modes
    .filter((entry) => entry.source === "user" && !entry.reserved && !isBuiltinMode(entry.id))
    .map((entry) => {
      const diagnostic = catalog.diagnostics.find((item) => item.modeId === entry.id);
      const reason = entry.available ? undefined : diagnostic?.errors[0] ?? diagnostic?.warnings[0];
      return {
        id: entry.id,
        label: entry.label.trim() || entry.id,
        description: entry.description,
        staged: entry.staged,
        available: entry.available,
        ...(reason ? { reason } : {}),
      };
    });
}

/** Modes keyboard cycling and the picker walk: builtins, then available user modes. */
export function pickerModeCycle(catalog: ModeCatalog | null | undefined): Mode[] {
  return [
    ...MODE_CYCLE,
    ...userModePickerEntries(catalog)
      .filter((entry) => entry.available)
      .map((entry) => entry.id),
  ];
}

/** The mode after `current` in the cycle; an unknown current starts over. */
export function nextPickerMode(current: Mode, cycle: readonly Mode[]): Mode {
  if (cycle.length === 0) return current;
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length] ?? cycle[0]!;
}

/** Display label of a mode id: localized for builtins, as written otherwise. */
export function modeDisplayLabel(
  t: (key: string) => string,
  mode: Mode,
  catalog: ModeCatalog | null | undefined,
): string {
  if (isBuiltinMode(mode)) return t(MODE_LABEL_KEYS[mode]);
  const entry = catalog?.modes.find((candidate) => candidate.id === mode && !candidate.reserved);
  return entry?.label.trim() || mode;
}
