/** Raw MCP tool names a user may allow in Plan and Goal. */
export const MAX_PLAN_SAFE_TOOLS = 32;

const PLAN_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** Validate nonblank draft entries; the host validates persisted input. */
export function planSafeToolsError(tools: readonly string[]): "shape" | "count" | null {
  let count = 0;
  for (const tool of tools) {
    const name = tool.trim();
    if (!name) continue;
    if (!PLAN_SAFE_TOOL_NAME.test(name)) return "shape";
    count += 1;
  }
  return count > MAX_PLAN_SAFE_TOOLS ? "count" : null;
}

export function normalizePlanSafeTools(tools: readonly string[]): string[] {
  if (planSafeToolsError(tools)) {
    throw new Error("MCP_INVALID: planSafeTools");
  }
  return tools.map((tool) => tool.trim()).filter(Boolean);
}

/** Names the user listed that the last successful test did not advertise. */
export function missingPlanSafeTools(
  listed: readonly string[],
  advertised: readonly string[] | undefined,
): string[] {
  if (!advertised) return [];
  const known = new Set(advertised);
  return listed.filter((name) => !known.has(name));
}
