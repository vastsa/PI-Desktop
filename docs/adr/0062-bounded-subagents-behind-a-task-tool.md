# ADR 0062: Bounded Subagents Behind a Task Tool

- Status: Accepted for implementation (definition roots amended by ADR 0112;
  timeout policy amended by ADR 0119; delegation presentation amended by D265;
  opt-in parent-tool inherit amended by ADR 0246; resumable delegations amended
  by ADR 0279; report spillover amended by RFC #1196)
- Date: 2026-08-06
- Related: ADR 0041, ADR 0048, ADR 0053, ADR 0112, ADR 0119, ADR 0246,
  ADR 0279, D123, D138, D198, D201, D265

## Context

A single agent loop pays for everything it reads: wide searches, long build logs,
and multi-file surveys land in the session context and stay there for the rest of
the task, and compaction can only recover space afterwards. Delegation runs the
separable piece in its own context and returns a report, so the open questions
are the boundaries: where definitions come from, what a delegate may do to the
workspace, how its rows relate to the parent, and what happens when several
delegates need the user at once.

## Decision

### 1. Definitions are Markdown documents, builtin plus global user documents

A definition is frontmatter plus a Markdown body that becomes the delegate's
system prompt (D123), stored as `~/.agents/subagents/<name>.md`. Three builtins
(`explorer`, `code-reviewer`, `test-runner`) ship inline in `agent-runtime` and
merge with the global user catalog by name at each session launch, capped at
`MAX_SUBAGENT_DEFINITIONS`, with a malformed document degrading to a launch
diagnostic.

### 2. A definition declares its tools, and is read-only when it does not

`tools` may only name `SUBAGENT_ASSIGNABLE_TOOLS` — file, search, and shell
tools — so plugin, skill, mode, and meta tools stay out of reach; omitting
`tools` grants `Read, Glob, Grep`, and `tools: "*"` expands to the assignable
set. Calls pass through the same `tools.execute` path, and a delegate cannot
submit a plan, change mode, or nest a `Task`.

### 3. A definition may pin its own provider and model

`model: <provider>/<model>` binds a delegate regardless of the session model,
resolved once per launch in Electron main and capped at
`MAX_SUBAGENT_PROVIDERS` distinct providers, matching on id, vendor key, or
display name. An unresolvable pin is left out of the binding map and the `Task`
call fails with a tool error naming it, so a cheap definition never silently
spends the expensive model.

### 4. Delegation is one Agent-mode tool, and parallel by construction

`Task` takes `agent`, `task`, and an optional `description`, carries its
delegate catalog in the tool description, and executes only in Agent mode, where
Plan and Goal keep their Task-family schemas declared but deny execution before
a delegate exists (D198). Concurrency comes from pi's execution modes, so only
an all-`Task` batch fans out, bounded by `MAX_SUBAGENT_CONCURRENCY`, with a
sidecar `PathMutex` serializing same-path mutations and the parent's bounded
retry policy applied to every delegate.

### 5. The parent's context gains the report, and only the report

The delegate's final message becomes the `Task` result, capped at
`MAX_SUBAGENT_REPORT_CHARS`, with `agent`, `status`, `turns`, `toolCalls`, and
`usage` as details; an oversized report is preserved under the session scratch
`delegations/<parentToolCallId>/report.md` and returned as a pointer notice.
Delegate rows persist with `parentToolCallId` and `agentName` for review but are
skipped when model context is rebuilt, so only the report reaches the parent and
a delegate's termination collapses into the tool result.

### 6. Attribution is persisted, and the transcript derives its topology from it

host-core stores `parentToolCallId` and `agentName` in the message `meta`
object, so a reloaded session nests exactly like a live one, with attributed
rows rendered one level in under the spawning `Task` row while the turn stream
and minimap see only parent rows. Every `Task` call draws as a delegation
summary (D265) whose header derives counts and status from those tool messages,
and live and reloaded views derive the same topology from the persisted ids
without adding a graph record, edge, IPC field, or storage schema.

### 7. Permission requests queue per session

Pending requests become a per-session queue, oldest first, where only the head is
answerable, answers match by request id, a host-expired request is removed by
tool call id, and an abort denies the whole queue. The card names the delegate
that asked and how many requests wait behind it.

## Consequences

- Wide searches, reviews, and command runs leave the session context at the price
  of one report each, and a user can add a delegate under `~/.agents/subagents`
  without a rebuild.
- Two capability surfaces exist for the same tools: a delegate can be strictly
  weaker than its session, never stronger.
- Delegate rows lengthen transcripts on disk but stay collapsed and out of model
  context, while review and rollback still see them.

## Alternatives considered

- Serial delegates in v1: rejected; fanning out a survey is most of the value,
  and retrofitting concurrency would redo the transcript and permission work.
- Feed delegate messages back into the parent's context: rejected; that is
  exactly the cost delegation removes.
