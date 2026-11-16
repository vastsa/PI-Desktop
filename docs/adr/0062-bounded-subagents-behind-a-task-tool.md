# ADR 0062: Bounded Subagents Behind a Task Tool

- Status: Accepted for implementation (definition roots amended by ADR 0112;
  timeout policy amended by ADR 0119; delegation presentation amended by D265;
  opt-in parent-tool inherit amended by ADR 0246; resumable delegations amended
  by ADR 0279; report spillover amended by RFC #1196)
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Related: D201, ADR 0041 (persistence outbox), ADR 0048 (lazy per-turn tool
  activation), ADR 0053 (plan checkpoint and execution epoch), D123 (prompt
  template documents), D138 (session-scoped inline permission requests),
  D198 (contract modes), ADR 0112 (capability roots and Settings IA), ADR 0119
  (event-driven subagent timeouts), D265 (one delegation reads as a card too),
  ADR 0246 (opt-in `tools: inherit`), ADR 0279 (resumable delegations)

## Context

A single agent loop pays for everything it reads. Wide searches, long build logs
and multi-file surveys are separable work whose intermediate output is worthless
once the conclusion is known, yet all of it lands in the session's context
window and stays there for the rest of the task.

## Decision

### 1. Definitions are Markdown documents, builtin plus global user documents

A subagent definition is frontmatter plus a Markdown body that becomes the
delegate's system prompt, mirroring prompt templates (D123):

```text
~/.agents/subagents/<name>.md
```

PI-Desktop ships three builtins inline in `agent-runtime` (`explorer`,
`code-reviewer`, `test-runner`). User documents under `~/.agents/subagents` are
combined with the builtins by name.

### 2. A definition declares its tools, and is read-only when it does not

`tools` may only name file, search and shell tools (`SUBAGENT_ASSIGNABLE_TOOLS`:
Read, Glob, Grep, BrowserPreview, Bash, Edit, Write). Plugin, skill, mode and
meta tools are out of reach: a delegate is a bounded worker, not a second full
session.

Every delegate tool call goes through the same `tools.execute` host path as the
parent's, so containment, permission modes and hard denies are unchanged. A
delegate cannot ask the model-facing questions the parent can: no plan or goal
submission, no mode transition, no nested `Task`.

### 3. A definition may pin its own provider and model

`model: <provider>/<model>` binds a delegate to a specific model regardless of
the session's. Pins are resolved once per launch in Electron main, where
credentials and the pi model catalog live, and are capped at
`MAX_SUBAGENT_PROVIDERS` (8) distinct providers.

An unresolvable pin (no matching provider, no API key) is left out of the
binding map instead of falling back to the session provider, and the `Task` call
fails with a tool error naming the pin. A definition that asks for a cheap model
must never silently spend the expensive one.

### 4. Delegation is one Agent-mode tool, and parallel by construction

Proposed amendment: [parallel file batches](parallel-read-batches.md) allows
Read/Glob/Grep/Write/Edit candidates, isolates delegate path-instruction
preparation, keeps a batch that mixes Task with those file tools sequential, and
holds a read or search ordered after a writable Task behind the delegate
completion boundary. The original only-Task batch policy below is historical.

The `Task` tool takes `agent`, `task` and an optional short `description`. The
catalog of available delegates rides in the tool description rather than the
system prompt, because the two change together.

### 5. The parent's context gains the report, and only the report

A `SubagentRun` is a second pi `Agent` in the same sidecar process. Its final
message, bounded to `MAX_SUBAGENT_REPORT_CHARS` (12k), becomes the `Task` tool
result, with `agent`, `status`, `turns`, `toolCalls` and `usage` as structured
details.

When a delegate's completed report exceeds `MAX_SUBAGENT_REPORT_CHARS`, the
runtime preserves the full, unclipped report in the session scratch directory
(`<data_dir>/scratch/<sessionId>/delegations/<parentToolCallId>/report.md`; an
opaque ID containing path separators is encoded before it is used as a path
component) and returns a compact pointer notice (`Complete subagent report (N
characters) was saved to: <path>`) alongside `scratchReportPath` in the
structured result. If scratch persistence fails, it degrades gracefully to
bounded head/tail clipping with a truncation marker.

### 6. Attribution is persisted, and the transcript derives its topology from it

host-core stores `parentToolCallId` and `agentName` in the message `meta`
object, so a reloaded session nests identically to a live one. The renderer
groups every attributed row under the `Task` row that spawned it and renders
them one level in; the turn stream and the minimap see only the parent's rows.

Every `Task` call in an activity group is drawn as a delegation summary, a lone
one included (D265). Consecutive `Task` starts are the only rows in that group
(D319): parent thinking, workspace tools, and lifecycle rows stay in ordinary
processing groups around the card.

### 7. Permission requests queue per session

The renderer used to hold one pending permission per session. Parallel delegates
break that: two delegates can each be waiting on a `Bash` call.

## Alternatives considered

- **Serial delegates in v1.** Simpler, and it would have avoided the path lock
  and the permission queue.
- **Inherit the session model always.** Cheaper to reason about.
- **Let delegates inherit the parent's tools.** Rejected for silent, always-on
  inherit: it makes every delegation as dangerous as the session, and a
  definition is the only place a reader can see what a delegate may do.
- **A separate process per delegate.** Real isolation, but it duplicates the
  host connection, provider setup and event plumbing for a bounded worker that
  already runs under host-core containment.

## Consequences

- Wide searches, reviews and command runs move out of the session's context at
  the price of one report each.
- A user can add a delegate under `~/.agents/subagents`; no rebuild, no settings
  change, effective on the next prompt when enabled locally.
- Two capability surfaces now exist for the same tools: the session's mode and a
  definition's `tools` list.
- The permission UX must handle more than one waiting request, which is visible
  to any user of parallel delegates.
- Delegate rows make transcripts longer on disk; they stay collapsed and out of
  model context, but review and rollback still see them.
