/**
 * Vocabulary and normalization for `AppSettings.sidebarModules`, shared by the
 * renderer and Electron Main so both sides accept exactly the same values.
 */
import type {
  SidebarModuleId,
  SidebarModulePreferences,
} from "./types/settings.js";

/**
 * Every hideable module, grouped as the sidebar renders them. A child lists
 * its parent so a hidden section also hides its toolbar buttons.
 */
export const SIDEBAR_MODULES = [
  { id: "newTask", group: "navigation" },
  { id: "scheduled", group: "navigation" },
  { id: "pluginMarket", group: "navigation" },
  { id: "pinnedSessions", group: "sessions" },
  { id: "sessions", group: "sessions" },
  { id: "sessionSort", group: "sessions", parent: "sessions" },
  { id: "newSession", group: "sessions", parent: "sessions" },
  { id: "projects", group: "projects" },
  { id: "newProject", group: "projects", parent: "projects" },
  { id: "projectNewTask", group: "projects", parent: "projects" },
  { id: "buildVersion", group: "footer" },
] as const satisfies readonly {
  id: SidebarModuleId;
  group: "navigation" | "sessions" | "projects" | "footer";
  parent?: SidebarModuleId;
}[];

export type SidebarModuleGroup = (typeof SIDEBAR_MODULES)[number]["group"];

export const SIDEBAR_MODULE_IDS: readonly SidebarModuleId[] =
  SIDEBAR_MODULES.map((module) => module.id);

const PARENT: Partial<Record<SidebarModuleId, SidebarModuleId>> =
  Object.fromEntries(
    SIDEBAR_MODULES.flatMap((module) =>
      "parent" in module ? [[module.id, module.parent]] : [],
    ),
  );

export function isSidebarModuleId(value: unknown): value is SidebarModuleId {
  return (
    typeof value === "string" &&
    (SIDEBAR_MODULE_IDS as readonly string[]).includes(value)
  );
}

/** The module's own switch, ignoring its parent. Absent means shown. */
export function sidebarModuleEnabled(
  preferences: SidebarModulePreferences | null | undefined,
  id: SidebarModuleId,
): boolean {
  return preferences?.[id] !== false;
}

/** Whether the module renders: its own switch and its parent's are both on. */
export function sidebarModuleVisible(
  preferences: SidebarModulePreferences | null | undefined,
  id: SidebarModuleId,
): boolean {
  const parent = PARENT[id];
  return (
    sidebarModuleEnabled(preferences, id) &&
    (parent === undefined || sidebarModuleEnabled(preferences, parent))
  );
}

/**
 * Normalizes a stored preference. Unknown keys and non-boolean values are
 * dropped, so a settings file touched by a newer build keeps a shape this
 * build can read.
 */
export function normalizeSidebarModulePreferences(
  value: unknown,
): SidebarModulePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const next: SidebarModulePreferences = {};
  for (const id of SIDEBAR_MODULE_IDS) {
    if (typeof raw[id] === "boolean") next[id] = raw[id] as boolean;
  }
  return next;
}

/**
 * A write error message, or null when the `sidebarModules` field is valid.
 * Unknown keys are tolerated (a newer build may add modules) but every value
 * must be a boolean.
 */
export function sidebarModulesWriteError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "sidebarModules is invalid";
  }
  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== "boolean") return `sidebarModules.${key} is invalid`;
  }
  return null;
}
