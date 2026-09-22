import { describe, expect, it } from "vitest";
import {
  CANONICAL_TOOL_NAMES,
  LEGACY_TOOL_NAME_ALIASES,
  normalizeToolName,
} from "./tool-names.js";

/**
 * `[input, expected]` pairs both implementations must agree on.
 *
 * `crates/host-core/src/tools/names.rs` declares the same table, and
 * `apps/desktop/test/tool-names-sync.test.mjs` compares the two tables entry by
 * entry, so a name added on one side alone turns the sync test red.
 */
const NORMALIZATION_CASES: ReadonlyArray<readonly [string, string]> = [
  // The legacy spelling recorded in existing transcripts and user config.
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
  // Case variants of the same names.
  ["READ", "read"],
  ["read", "read"],
  ["rEaD", "read"],
  ["TASKWAIT", "task_wait"],
  ["browserPREVIEW", "browser_preview"],
  ["New_Context", "new_context"],
  ["ASKTOOL", "asktool"],
  ["TOOLSEARCH", "tool_search"],
  ["SCHEDULEDTASKCREATE", "scheduled_task_create"],
  ["PLUGINCHECK", "check_plugin"],
  // Names that are not ours to rewrite.
  ["PowerShell", "PowerShell"],
  ["powershell", "powershell"],
  ["plugin_pi_browser_Browser", "plugin_pi_browser_Browser"],
  ["mcp_firecrawl_firecrawl_scrape", "mcp_firecrawl_firecrawl_scrape"],
  ["plugin_tool", "plugin_tool"],
  ["", ""],
  ["TaskRunner", "TaskRunner"],
  ["readFile", "readFile"],
];

describe("canonical tool names", () => {
  it("are lowercase snake_case and never claim a third-party prefix", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      expect(name).toMatch(/^[a-z0-9_]+$/);
      expect(name.startsWith("plugin_") || name.startsWith("mcp_")).toBe(false);
    }
    expect(new Set(CANONICAL_TOOL_NAMES).size).toBe(CANONICAL_TOOL_NAMES.length);
  });

  it("are used as the target of every declared legacy alias", () => {
    for (const [legacy, canonical] of LEGACY_TOOL_NAME_ALIASES) {
      expect(legacy.length).toBeGreaterThan(0);
      expect(CANONICAL_TOOL_NAMES).toContain(canonical);
    }
  });
});

describe("normalizeToolName", () => {
  it("maps every legacy name and declared case to its canonical name", () => {
    for (const [legacy, canonical] of LEGACY_TOOL_NAME_ALIASES) {
      expect(normalizeToolName(legacy)).toBe(canonical);
    }
    for (const [input, expected] of NORMALIZATION_CASES) {
      expect(normalizeToolName(input)).toBe(expected);
    }
  });

  it("is idempotent", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      expect(normalizeToolName(name)).toBe(name);
      expect(normalizeToolName(normalizeToolName(name))).toBe(name);
    }
    for (const [input] of NORMALIZATION_CASES) {
      const once = normalizeToolName(input);
      expect(normalizeToolName(once)).toBe(once);
    }
  });

  it("hands back a canonical or unknown name unchanged", () => {
    for (const untouched of [
      ...CANONICAL_TOOL_NAMES,
      "PowerShell",
      "plugin_pi_browser_Browser",
      "mcp_firecrawl_firecrawl_scrape",
      "",
    ]) {
      expect(normalizeToolName(untouched)).toBe(untouched);
    }
  });
});
