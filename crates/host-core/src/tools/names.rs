//! Canonical tool names and the one normalization boundary over them.
//!
//! A tool name is the wire identity of a tool: the model emits it in a tool
//! call, permission rules match on it, subagent tool sets are declared with it,
//! and the transcript on disk stores it. PI-Desktop used to spell these names
//! the way the UI shows them (`Read`, `Bash`, `TaskWait`), while the pi runtime
//! branches on its own lowercase names (`read`, `bash`, ...) inside helpers such
//! as `extractFileOpsFromMessage`. Both spellings meet here.
//!
//! Three invariants this module owns:
//!
//! 1. Every tool name the host sends to a model is a canonical name, and
//!    canonical names are lowercase `snake_case`.
//! 2. A name read back from disk, from user configuration, or from an imported
//!    archive may still be a pre-rename spelling; it is normalized at the read
//!    boundary instead of being rewritten in storage.
//! 3. A third-party tool name (`plugin_*`, `mcp_*`, anything an MCP server
//!    reports) is never rewritten. It is not ours to rename.
//!
//! `packages/shared/src/tool-names.ts` mirrors this module, and
//! `apps/desktop/test/tool-names-sync.test.mjs` fails when the two drift apart.
//! The contract itself is documented in `docs/spec/03-runtime/23-tool-names.md`.

use std::borrow::Cow;

/// Canonical, model-visible tool names.
///
/// The order and the contents are part of the contract: the TypeScript mirror
/// lists them in the same order, and the sync test compares the two arrays
/// element by element. Names outside this list (third-party `plugin_*` /
/// `mcp_*` tools, shell ids such as `PowerShell`, MCP-reported names) keep their
/// own spelling.
pub const CANONICAL_TOOL_NAMES: &[&str] = &[
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

/// The spelling each canonical name had before the rename, paired with the
/// canonical name it resolves to.
///
/// Pure case variants (`READ`, `rEaD`) are already covered by the
/// case-insensitive fallback in [`normalize_tool_name`]; the pairs are listed
/// anyway so the legacy surface stays enumerable for permission rules, subagent
/// tool lists, and the migration documentation.
pub const LEGACY_TOOL_NAME_ALIASES: &[(&str, &str)] = &[
    ("Read", "read"),
    ("Write", "write"),
    ("Edit", "edit"),
    ("Bash", "bash"),
    ("Grep", "grep"),
    ("Glob", "glob"),
    ("Task", "task"),
    ("TaskWait", "task_wait"),
    ("TaskList", "task_list"),
    ("TaskStop", "task_stop"),
    ("Skill", "skill"),
    ("BrowserPreview", "browser_preview"),
    ("GenerateImages", "generate_images"),
    ("asktool", "asktool"),
    ("new_context", "new_context"),
    ("ToolSearch", "tool_search"),
    ("PluginCheck", "check_plugin"),
    ("PluginScaffold", "scaffold_plugin"),
    ("PluginPack", "pack_plugin"),
    ("EnterPlanMode", "enter_plan_mode"),
    ("EnterGoalMode", "enter_goal_mode"),
    ("SubmitPlan", "submit_plan"),
    ("SubmitGoal", "submit_goal"),
    ("ScheduledTaskList", "scheduled_task_list"),
    ("ScheduledTaskCreate", "scheduled_task_create"),
    ("ScheduledTaskUpdate", "scheduled_task_update"),
    ("ScheduledTaskDelete", "scheduled_task_delete"),
];

/// Resolve a stored, configured, or imported tool name to its canonical name.
///
/// * a canonical name returns unchanged (the call is idempotent);
/// * a known legacy name, in any letter case, returns its canonical name;
/// * anything else — `plugin_*`, `mcp_*`, an MCP-reported name, a shell id such
///   as `PowerShell`, an empty or unknown string — returns unchanged.
///
/// Pure, side-effect free, and infallible: an unknown name is not an error, it
/// simply has no canonical form to map to. A borrowed result means nothing had
/// to change.
pub fn normalize_tool_name(name: &str) -> Cow<'_, str> {
    if CANONICAL_TOOL_NAMES.contains(&name) {
        return Cow::Borrowed(name);
    }
    if let Some((_, canonical)) = LEGACY_TOOL_NAME_ALIASES
        .iter()
        .find(|(legacy, _)| *legacy == name)
    {
        return Cow::Owned((*canonical).to_owned());
    }
    match case_insensitive_canonical(name) {
        Some(canonical) => Cow::Owned(canonical.to_owned()),
        None => Cow::Borrowed(name),
    }
}

/// The canonical name a case-insensitive spelling of a known name resolves to.
///
/// Both tables are searched because a legacy multi-word name is not a case
/// variant of its canonical form (`TaskWait` is not `task_wait` ignoring case,
/// it is `taskwait`), while `Bash` is.
fn case_insensitive_canonical(name: &str) -> Option<&'static str> {
    if let Some(canonical) = CANONICAL_TOOL_NAMES
        .iter()
        .find(|canonical| canonical.eq_ignore_ascii_case(name))
    {
        return Some(canonical);
    }
    LEGACY_TOOL_NAME_ALIASES
        .iter()
        .find(|(legacy, _)| legacy.eq_ignore_ascii_case(name))
        .map(|(_, canonical)| *canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `[input, expected]` pairs both implementations must agree on.
    ///
    /// `packages/shared/src/tool-names.test.ts` declares the same table, and
    /// `apps/desktop/test/tool-names-sync.test.mjs` compares the two tables
    /// entry by entry, so a name added on one side alone turns the sync test
    /// red.
    const NORMALIZATION_CASES: &[(&str, &str)] = &[
        // The legacy spelling recorded in existing transcripts and user config.
        ("Read", "read"),
        ("Write", "write"),
        ("Edit", "edit"),
        ("Bash", "bash"),
        ("Grep", "grep"),
        ("Glob", "glob"),
        ("Task", "task"),
        ("TaskWait", "task_wait"),
        ("TaskList", "task_list"),
        ("TaskStop", "task_stop"),
        ("Skill", "skill"),
        ("BrowserPreview", "browser_preview"),
        ("GenerateImages", "generate_images"),
        ("asktool", "asktool"),
        ("new_context", "new_context"),
        ("ToolSearch", "tool_search"),
        ("PluginCheck", "check_plugin"),
        ("PluginScaffold", "scaffold_plugin"),
        ("PluginPack", "pack_plugin"),
        ("EnterPlanMode", "enter_plan_mode"),
        ("EnterGoalMode", "enter_goal_mode"),
        ("SubmitPlan", "submit_plan"),
        ("SubmitGoal", "submit_goal"),
        ("ScheduledTaskList", "scheduled_task_list"),
        ("ScheduledTaskCreate", "scheduled_task_create"),
        ("ScheduledTaskUpdate", "scheduled_task_update"),
        ("ScheduledTaskDelete", "scheduled_task_delete"),
        // Case variants of the same names.
        ("READ", "read"),
        ("read", "read"),
        ("rEaD", "read"),
        ("TASKWAIT", "task_wait"),
        ("browserPREVIEW", "browser_preview"),
        ("New_Context", "new_context"),
        ("ASKTOOL", "asktool"),
        ("TOOLSEARCH", "tool_search"),
        ("SCHEDULEDTASKCREATE", "scheduled_task_create"),
        ("PLUGINCHECK", "check_plugin"),
        // Names that are not ours to rewrite.
        ("PowerShell", "PowerShell"),
        ("powershell", "powershell"),
        ("plugin_pi_browser_Browser", "plugin_pi_browser_Browser"),
        (
            "mcp_firecrawl_firecrawl_scrape",
            "mcp_firecrawl_firecrawl_scrape",
        ),
        ("plugin_tool", "plugin_tool"),
        ("", ""),
        ("TaskRunner", "TaskRunner"),
        ("readFile", "readFile"),
    ];

    #[test]
    fn canonical_names_are_lowercase_snake_case() {
        for name in CANONICAL_TOOL_NAMES {
            assert!(
                !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{name} is not lowercase snake_case"
            );
            assert!(
                !name.starts_with("plugin_") && !name.starts_with("mcp_"),
                "{name} claims a third-party name prefix"
            );
        }
    }

    #[test]
    fn every_declared_alias_targets_a_canonical_name() {
        for (legacy, canonical) in LEGACY_TOOL_NAME_ALIASES {
            assert!(
                CANONICAL_TOOL_NAMES.contains(canonical),
                "{legacy} maps to {canonical}, which is not a canonical name"
            );
            assert!(
                !legacy.is_empty(),
                "an empty legacy name can never be matched"
            );
        }
    }

    /// Every legacy name in both tables maps to its canonical spelling, which
    /// also proves the two shared tables agree with the implementation.
    #[test]
    fn legacy_names_normalize_to_their_canonical_name() {
        for (legacy, canonical) in LEGACY_TOOL_NAME_ALIASES {
            assert_eq!(
                normalize_tool_name(legacy),
                *canonical,
                "{legacy} did not normalize to {canonical}"
            );
        }
        for (input, expected) in NORMALIZATION_CASES {
            assert_eq!(
                normalize_tool_name(input),
                *expected,
                "{input} did not normalize to {expected}"
            );
        }
    }

    #[test]
    fn normalization_is_idempotent() {
        for name in CANONICAL_TOOL_NAMES {
            let once = normalize_tool_name(name);
            assert_eq!(once, *name);
            assert_eq!(normalize_tool_name(&once), once);
        }
        for (input, _) in NORMALIZATION_CASES {
            let once = normalize_tool_name(input);
            assert_eq!(normalize_tool_name(&once), once, "{input} drifted");
        }
    }

    /// A name that is already canonical, or that is not ours at all, must be
    /// handed back without allocating a copy.
    #[test]
    fn untouched_names_are_borrowed() {
        for name in CANONICAL_TOOL_NAMES {
            assert!(matches!(normalize_tool_name(name), Cow::Borrowed(_)));
        }
        for untouched in [
            "PowerShell",
            "plugin_pi_browser_Browser",
            "mcp_firecrawl_firecrawl_scrape",
            "",
        ] {
            assert!(
                matches!(normalize_tool_name(untouched), Cow::Borrowed(_)),
                "{untouched} was rewritten"
            );
            assert_eq!(normalize_tool_name(untouched), untouched);
        }
    }
}
