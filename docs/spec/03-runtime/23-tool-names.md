# 23. Tool Name Contract

> Decisions applied: D618, D621

## 0. Frozen policy summary

| Topic | Decision |
|---|---|
| Model-visible names | Lowercase `snake_case` (`read`, `bash`, `task_wait`), enumerated in `CANONICAL_TOOL_NAMES` |
| Display names | The UI keeps the capitalized form (`Read`, `Bash`) and derives it from the canonical name |
| Stored names | Transcripts, audit rows, and saved configuration keep the spelling they were written with; a read normalizes |
| Third-party names | `plugin_*`, `mcp_*`, and MCP-reported names are never rewritten |
| Unknown names | Returned unchanged; normalization does not fail and does not guess |
| Contract owners | `crates/host-core/src/tools/names.rs` and `packages/shared/src/tool-names.ts` |

## 1. Canonical names

The model-visible tool name is the wire identity of a tool. It is what the model
emits in a tool call, what permission rules match on, what subagent tool sets are
declared with, and what the transcript stores. The pi runtime branches on its own
lowercase names inside helpers such as `extractFileOpsFromMessage`; a name that is
spelled differently is a name pi does not recognize.

| Legacy spelling | Canonical name | Note |
|---|---|---|
| `Read` | `read` | same name as pi |
| `Write` | `write` | same name as pi |
| `Edit` | `edit` | same name as pi |
| `Bash` | `bash` | same name as pi |
| `Grep` | `grep` | same name as pi |
| `Glob` | `glob` | pi exposes `find` / `ls` instead; only the letter case changes |
| `Task` | `task` | |
| `TaskWait` | `task_wait` | multi-word names use `snake_case` |
| `TaskList` | `task_list` | |
| `TaskStop` | `task_stop` | |
| `Skill` | `skill` | |
| `BrowserPreview` | `browser_preview` | |
| `GenerateImages` | `generate_images` | |
| `asktool` | `asktool` | already lowercase; unchanged by this decision |
| `new_context` | `new_context` | already lowercase; unchanged by this decision |
| `ToolSearch` | `tool_search` | |
| `PluginCheck` | `check_plugin` | verb-first, see the note below the table |
| `PluginScaffold` | `scaffold_plugin` | |
| `PluginPack` | `pack_plugin` | |
| `EnterPlanMode` | `enter_plan_mode` | |
| `EnterGoalMode` | `enter_goal_mode` | |
| `SubmitPlan` | `submit_plan` | |
| `SubmitGoal` | `submit_goal` | |
| `ScheduledTaskList` | `scheduled_task_list` | |
| `ScheduledTaskCreate` | `scheduled_task_create` | |
| `ScheduledTaskUpdate` | `scheduled_task_update` | |
| `ScheduledTaskDelete` | `scheduled_task_delete` | |


The table is the migration surface, not a statement that every entry is emitted
today. A tool name outside it — an MCP server's own name, a shell id such as
`PowerShell`, any third-party `plugin_*` / `mcp_*` tool — keeps its own spelling.

The three plugin-development tools are named verb-first (`check_plugin`) on
purpose. `plugin_` is the reserved marker for a tool a third-party plugin
contributes, and the host branches on that prefix, so prefixing the host's own
plugin-development tools with it would make the two indistinguishable.

## 2. The normalization boundary

Both languages expose the same pure function; neither performs I/O.

```rust
pub const CANONICAL_TOOL_NAMES: &[&str];
pub fn normalize_tool_name(name: &str) -> std::borrow::Cow<'_, str>;
```

```ts
export const CANONICAL_TOOL_NAMES: readonly string[];
export function normalizeToolName(name: string): string;
```

Semantics:

- a canonical name returns unchanged, so the call is idempotent;
- a known legacy name returns its canonical name, in any letter case
  (`Read`, `READ`, and `rEaD` all resolve to `read`);
- any other name — `plugin_*`, `mcp_*`, an MCP-reported name, a shell id such as
  `PowerShell`, an empty or unknown string — returns unchanged. An unknown name
  is not an error;
- letter case is compared over ASCII only, so the two implementations cannot
  disagree on a non-ASCII name.

Normalize on the way **in**. A stored or configured name is translated where it
is read, and is not rewritten in storage: existing transcripts, audit rows, deny
and allow rules, plugin manifests, and subagent tool lists keep the bytes they
already have, and old data stays usable without a migration.

## 3. Where a name must be normalized

Every read of a tool name that was written before the rename, or that a user or a
third party supplied:

1. transcript and session history reads, including the compaction file-operation
   collection, delegation history, tool-result tiering, and the system transcript;
2. permission rule matching for `deny` and `allow` entries;
3. subagent tool whitelists and tool-set predicates;
4. the built-in-versus-contributed decision for plugin and MCP tool lists, which
   keep their own names but participate in that check under their canonical form;
5. session import from an external archive;
6. the plan and goal mode-transition tool sets.

A write path always writes the canonical name, so newly persisted data needs no
normalization.

## 4. What proves the contract

| Guard | Covers |
|---|---|
| `cargo test -p host-core names` | the Rust implementation, the alias table, idempotency, and untouched names |
| `pnpm --filter @pi-desktop/shared test` | the TypeScript mirror, with the same case table |
| `node --test apps/desktop/test/tool-names-sync.test.mjs` | the two name lists, the two alias tables, and the two case tables must be identical |

The sync test reads both sources, so a name added on one side alone fails it. It
compares the tables, not the behavior: behavior is pinned by the unit test next
to each implementation.

Until the first host-core caller lands (D619), the Rust module carries a
`#![allow(dead_code)]` and the re-export carries `#[allow(unused_imports)]`,
because this binary crate has no reference to either yet. That change removes
both.

## 5. The display layer

Identity is the canonical name; a label is only how a reader sees it. The
desktop owns that translation in one place and nothing else does, so moving the
wire name to lowercase changed no visible label (D621).

| Where | What it does |
|---|---|
| `apps/desktop/src/lib/tool-display.ts` | Resolves every name it is handed to its canonical identity first (`canonicalToolName`), then answers from it: `getToolAction` picks the row's verb, `isDelegationStartTool` and `delegationLifecycleKind` decide the delegation presentation, `getToolDisplayName` builds the capitalized label |
| `getToolPromptName` | The variant the surfaces outside a transcript row use (the permission prompt). Our tools show their capitalized label; a third-party name (`plugin_*`, `mcp_*`) is left exactly as the server reported it, because a prompt the user is asked to approve must not hide which tool is asking |
| Equality checks elsewhere | Normalize first: the review change tools (`write` / `edit`), the generated-image row (`generate_images`), the context-inspector grouping key, the desktop RPC timeout budgets (`bash`, `generate_images`), and the local tools Electron main registers (`skill`, `browser_preview`, `generate_images`, `check_plugin`, `scaffold_plugin`, `pack_plugin`) |

The labels themselves are unchanged by the rename: `read` renders as `Read`,
`task_wait` as `Task Wait`, and the legacy `Read` / `TaskWait` spellings still
render exactly the same, because the label is derived from the canonical name
rather than from the spelling that happened to reach the transcript. A
third-party tool keeps its own words everywhere.
