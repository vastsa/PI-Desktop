/**
 * Canonical tool names and the one normalization boundary over them.
 *
 * A tool name is the wire identity of a tool: the model emits it in a tool
 * call, permission rules match on it, subagent tool sets are declared with it,
 * and the transcript on disk stores it. PI-Desktop used to spell these names the
 * way the UI shows them (`Read`, `Bash`, `TaskWait`), while the pi runtime
 * branches on its own lowercase names (`read`, `bash`, ...) inside helpers such
 * as `extractFileOpsFromMessage`. Both spellings meet here.
 *
 * Three invariants this module owns:
 *
 * 1. Every tool name the runtime sends to a model is a canonical name, and
 *    canonical names are lowercase `snake_case`.
 * 2. A name read back from disk, from user configuration, or from an imported
 *    archive may still be a pre-rename spelling; it is normalized at the read
 *    boundary instead of being rewritten in storage.
 * 3. A third-party tool name (`plugin_*`, `mcp_*`, anything an MCP server
 *    reports) is never rewritten. It is not ours to rename.
 *
 * `crates/host-core/src/tools/names.rs` mirrors this module, and
 * `apps/desktop/test/tool-names-sync.test.mjs` fails when the two drift apart.
 * The contract itself is documented in `docs/spec/03-runtime/23-tool-names.md`.
 */

/**
 * Canonical, model-visible tool names.
 *
 * The order and the contents are part of the contract: the Rust mirror lists
 * them in the same order, and the sync test compares the two arrays element by
 * element. Names outside this list (third-party `plugin_*` / `mcp_*` tools,
 * shell ids such as `PowerShell`, MCP-reported names) keep their own spelling.
 */
export const CANONICAL_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "task",
  "task_wait",
  "task_list",
  "task_stop",
  "skill",
  "browser_preview",
  "generate_images",
  "asktool",
  "new_context",
  "tool_search",
  "check_plugin",
  "scaffold_plugin",
  "pack_plugin",
  "enter_plan_mode",
  "enter_goal_mode",
  "submit_plan",
  "submit_goal",
  "scheduled_task_list",
  "scheduled_task_create",
  "scheduled_task_update",
  "scheduled_task_delete",
];

/**
 * The spelling each canonical name had before the rename, paired with the
 * canonical name it resolves to.
 *
 * Pure case variants (`READ`, `rEaD`) are already covered by the
 * case-insensitive fallback in {@link normalizeToolName}; the pairs are listed
 * anyway so the legacy surface stays enumerable for permission rules, subagent
 * tool lists, and the migration documentation.
 */
export const LEGACY_TOOL_NAME_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["Bash", "bash"],
  ["Grep", "grep"],
  ["Glob", "glob"],
  ["Task", "task"],
  ["TaskWait", "task_wait"],
  ["TaskList", "task_list"],
  ["TaskStop", "task_stop"],
  ["Skill", "skill"],
  ["BrowserPreview", "browser_preview"],
  ["GenerateImages", "generate_images"],
  ["asktool", "asktool"],
  ["new_context", "new_context"],
  ["ToolSearch", "tool_search"],
  ["PluginCheck", "check_plugin"],
  ["PluginScaffold", "scaffold_plugin"],
  ["PluginPack", "pack_plugin"],
  ["EnterPlanMode", "enter_plan_mode"],
  ["EnterGoalMode", "enter_goal_mode"],
  ["SubmitPlan", "submit_plan"],
  ["SubmitGoal", "submit_goal"],
  ["ScheduledTaskList", "scheduled_task_list"],
  ["ScheduledTaskCreate", "scheduled_task_create"],
  ["ScheduledTaskUpdate", "scheduled_task_update"],
  ["ScheduledTaskDelete", "scheduled_task_delete"],
];

const ASCII_UPPERCASE = /[A-Z]/g;

/**
 * Lower the ASCII letters only, matching Rust's `eq_ignore_ascii_case`. A
 * locale-aware `toLowerCase()` would fold characters these tables never contain
 * and could make the two implementations disagree on a non-ASCII name.
 */
function asciiFold(value: string): string {
  return value.replace(ASCII_UPPERCASE, (letter) => letter.toLowerCase());
}

/**
 * Resolve a stored, configured, or imported tool name to its canonical name.
 *
 * * a canonical name returns unchanged (the call is idempotent);
 * * a known legacy name, in any letter case, returns its canonical name;
 * * anything else — `plugin_*`, `mcp_*`, an MCP-reported name, a shell id such as
 *   `PowerShell`, an empty or unknown string — returns unchanged.
 *
 * Pure and infallible: an unknown name is not an error, it simply has no
 * canonical form to map to.
 */
export function normalizeToolName(name: string): string {
  if (CANONICAL_TOOL_NAMES.includes(name)) return name;
  const alias = LEGACY_TOOL_NAME_ALIASES.find(([legacy]) => legacy === name);
  if (alias) return alias[1];
  const folded = asciiFold(name);
  const canonical = CANONICAL_TOOL_NAMES.find((candidate) => asciiFold(candidate) === folded);
  if (canonical) return canonical;
  const legacy = LEGACY_TOOL_NAME_ALIASES.find(([legacyName]) => asciiFold(legacyName) === folded);
  return legacy ? legacy[1] : name;
}
