# 23. Tool Name Contract

> Decisions applied: D618

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
| `Review` | `review` | |
| `EnterPlanMode` | `enter_plan_mode` | |
| `EnterGoalMode` | `enter_goal_mode` | |
| `SubmitPlan` | `submit_plan` | |
| `SubmitGoal` | `submit_goal` | |
| `asktool` | `asktool` | already lowercase; unchanged by this decision |
| `new_context` | `new_context` | already lowercase; unchanged by this decision |

The table is the migration surface, not a statement that every entry is emitted
today. A tool name outside it — `PluginCheck`, `PluginScaffold`, `PluginPack`,
an MCP server's own name — keeps its current spelling until the table covers it.

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
