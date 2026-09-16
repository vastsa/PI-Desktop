import {
  fallbackBuiltinDefinitions,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";

/**
 * One shipped default plus whether this installation still offers it.
 *
 * A switched-off builtin stays in the list on purpose: it has no document to
 * delete, so its row and its switch are the only way back on.
 */
export type BuiltinSubagentRow = SubagentDefinition & { enabled: boolean };

/** User-owned documents plus the shipped defaults, switched off ones included. */
export type SubagentPageData = {
  owned: UserSubagentRecord[];
  builtins: BuiltinSubagentRow[];
};

export const EMPTY_SUBAGENT_PAGE: SubagentPageData = {
  owned: [],
  builtins: [],
};

/**
 * Settings lists two sources: the writable global registry, and the shipped
 * defaults `Task` offers. Catalog load failures must not hide the user list, so
 * builtins fall back to the shared preset catalog — reported enabled, because a
 * failed read cannot say which handles the user turned off.
 */
export async function fetchSubagentPageData(): Promise<SubagentPageData> {
  const ownedResult = await api.listUserSubagents({ level: "global" });
  const owned = ownedResult.subagents ?? [];
  const enabledHandles = new Set(owned.filter((row) => row.enabled).map((row) => row.id));
  try {
    const catalog = await api.subagentCatalog();
    // Older main processes answer without `builtins`; derive the group from the
    // effective catalog then, which is how this page read it before builtins
    // could be switched off at all.
    const builtins =
      catalog.builtins ??
      (catalog.subagents ?? [])
        .filter((item) => item.source === "builtin")
        .map((item) => ({ ...item, enabled: true }));
    return {
      owned,
      builtins: builtins.filter(
        (item) => item.source === "builtin" && !enabledHandles.has(item.name),
      ),
    };
  } catch {
    return {
      owned,
      builtins: fallbackBuiltinDefinitions()
        .map((item) => ({ ...item, enabled: true }))
        .filter((item) => !enabledHandles.has(item.name)),
    };
  }
}
