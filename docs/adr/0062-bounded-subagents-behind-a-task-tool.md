# ADR 0062: Bounded Subagents Behind a Task Tool

- Status: Accepted for implementation (definition roots amended by ADR 0112;
  timeout policy amended by ADR 0119; delegation presentation amended by D265)
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Related: D201, ADR 0041 (persistence outbox), ADR 0048 (lazy per-turn tool
  activation), ADR 0053 (plan checkpoint and execution epoch), D123 (prompt
  template documents), D138 (session-scoped inline permission requests),
  D198 (contract modes), ADR 0112 (capability roots and Settings IA), ADR 0119
  (event-driven subagent timeouts), D265 (one delegation reads as a card too)

## Context

A single agent loop pays for everything it reads. Wide searches, long build
logs and multi-file surveys are separable work whose intermediate output is
worthless once the conclusion is known, yet all of it lands in the session's
context window and stays there for the rest of the task. Automatic compaction
(ADR 0049) recovers space after the fact; it cannot avoid spending it.

Delegation is the standard answer: run the separable piece in its own context
and return only a report. Adding it to PI-Desktop touches every layer, and the
open questions are not about the loop itself but about the boundaries — where
definitions come from, what a delegate may do to the workspace, how a delegate's
rows relate to the parent's model context and to the transcript, and what
happens when several delegates want the user's attention at once.

## Decision

### 1. Definitions are Markdown documents, builtin plus global user documents

A subagent definition is frontmatter plus a Markdown body that becomes the
delegate's system prompt, mirroring prompt templates (D123):

```text
~/.agents/subagents/<name>.md
```

PI-Desktop ships three builtins inline in `agent-runtime` (`explorer`,
`code-reviewer`, `test-runner`). User documents under `~/.agents/subagents`
are combined with the builtins by name. There is no project-level subagent
capability source; the global user catalog is the only user-managed layer.
The catalog is re-read
on every session launch, capped at `MAX_SUBAGENT_DEFINITIONS` (16), and a
malformed document degrades to a launch diagnostic — it never costs the session
its other delegates or its turn.

Frontmatter keys: `name`, `description`, `tools`, `model`, `thinkingLevel`,
`maxTurns`, `idle-timeout`, and `max-duration`. Key spelling is matched
loosely (`max-turns`, `max_turns`, `maxTurns`). `maxTurns` is optional;
omission, `none`, and `0` mean unlimited turns. The timeout defaults and
bounds are defined by ADR 0119.

### 2. A definition declares its tools, and is read-only when it does not

`tools` may only name file, search and shell tools
(`SUBAGENT_ASSIGNABLE_TOOLS`: Read, Glob, Grep, BrowserPreview, Bash, Edit,
Write). Plugin, skill, mode and meta tools are out of reach: a delegate is a
bounded worker, not a second full session. A definition that omits `tools` gets
`Read, Glob, Grep`, and `tools: "*"` expands to the assignable set rather than to
everything the session has. A delegate never inherits mutation rights from the
parent session — write capability comes only from its own declaration.

Every delegate tool call goes through the same `tools.execute` host path as the
parent's, so containment, permission modes and hard denies are unchanged. A
delegate cannot ask the model-facing questions the parent can: no plan or goal
submission, no mode transition, no nested `Task`.

### 3. A definition may pin its own provider and model

`model: <provider>/<model>` binds a delegate to a specific model regardless of
the session's. Pins are resolved once per launch in Electron main, where
credentials and the pi model catalog live, and are capped at
`MAX_SUBAGENT_PROVIDERS` (8) distinct providers. Because stored provider ids are
UUIDs, a pin matches on id, vendor key or display name.

An unresolvable pin (no matching provider, no API key) is left out of the
binding map instead of falling back to the session provider, and the `Task` call
fails with a tool error naming the pin. A definition that asks for a cheap model
must never silently spend the expensive one.

### 4. Delegation is one Agent-mode tool, and parallel by construction

The `Task` tool takes `agent`, `task` and an optional short `description`. The
catalog of available delegates rides in the tool description rather than the
system prompt, because the two change together.

`Task` is offered only in Agent mode. Plan and Goal are read-only contract
negotiations (D198), and a delegate with Bash or Edit would drive straight
through one.

Concurrency is expressed through pi's execution modes: the session Agent runs
with `toolExecution: "parallel"`, every catalog tool carries
`executionMode: "sequential"`, and `Task` alone carries `"parallel"`. pi runs a
batch sequentially as soon as it contains one sequential tool, so the only batch
that fans out is a batch of nothing but `Task` calls. Existing tool ordering
guarantees are untouched. Fan-out is capped at `MAX_SUBAGENT_CONCURRENCY` (4)
by a semaphore. Delegate runtime bounds are the event-driven idle and
total-duration watchdogs in ADR 0119; an explicit per-definition `maxTurns`
remains an optional hard backstop with a maximum of 80.

Fan-out makes one same-process ordering problem real, and the sidecar owns it.
host-core admits one mutation per session at a time, so concurrent writes cannot
tear, but it defines no order between two same-path mutations — and the sidecar's
edit-recovery contract counts failures per path and terminates the second failed
`Edit` on one file, which only means "re-read and retry once" if the attempts
were ordered. A `PathMutex` in the sidecar serializes mutating calls per
normalized path; different paths never wait on each other, which is the point.
Delegates also run under the same bounded provider retry policy as the parent
(one retry, 8s delay cap), so a fan-out cannot turn one failing provider into a
retry storm.

### 5. The parent's context gains the report, and only the report

A `SubagentRun` is a second pi `Agent` in the same sidecar process. Its final
message, bounded to `MAX_SUBAGENT_REPORT_CHARS` (12k), becomes the `Task` tool
result, with `agent`, `status`, `turns`, `toolCalls` and `usage` as structured
details.

Delegate messages and tool rows are still emitted and persisted — they are what
makes a delegation reviewable — but every row carries `parentToolCallId` and
`agentName`, and the runtime skips those rows when it rebuilds model context.
Replaying them would both contradict what the parent actually saw and reintroduce
the context cost delegation exists to avoid.

A delegate's termination — success, cap, timeout, failure, abort — collapses
into the tool result. It never reaches Electron main's turn handling, so the
parent turn remains the only thing that can end a turn. See ADR 0119 for the
timeout policy and `timed_out` outcome.

### 6. Attribution is persisted, and the transcript derives its topology from it

host-core stores `parentToolCallId` and `agentName` in the message `meta`
object, so a reloaded session nests identically to a live one. The renderer
groups every attributed row under the `Task` row that spawned it and renders
them one level in; the turn stream and the minimap see only the parent's rows.
The report is printed once: in the `Task` body when the delegate produced no
answer row, as the nested answer row otherwise.

Every `Task` call in an activity group is drawn as a delegation summary, a lone
one included (D265). Consecutive `Task` starts are the only rows in that group
(D319): parent thinking, workspace tools, and lifecycle rows stay in ordinary
processing groups around the card. Its header derives agent count, settled count, elapsed time
and aggregate status from those same tool messages; its expanded body renders a
one-level main-agent-to-delegate topology. Each delegate node retains the
original row disclosure, brief, report, counters and nested steps. Live fan-out
opens the topology once when it first appears, then leaves expansion under user
control; reloaded history stays collapsed. No graph record, edge, IPC field or
storage schema is added: live and reload both derive the same topology from the
persisted parent ids, and the UI never invents delegate-to-delegate edges or a
parent summary it does not own.

### 7. Permission requests queue per session

The renderer used to hold one pending permission per session. Parallel delegates
break that: two delegates can each be waiting on a `Bash` call. Pending requests
become a per-session queue, oldest first. Only the head is answerable, answers
are matched by request id so a late answer cannot clear a successor, a
host-expired request is removed by tool call id from anywhere in the queue, and
an abort denies the whole queue. The card names the delegate that asked and how
many requests wait behind it.

## Alternatives considered

- **Serial delegates in v1.** Simpler, and it would have avoided the path lock
  and the permission queue. Rejected: the value of delegation is largely in
  fanning out a survey, and retrofitting concurrency would have meant redoing
  the transcript and permission work.
- **Inherit the session model always.** Cheaper to reason about. Rejected: a
  wide search is exactly the work worth doing on a cheap fast model while the
  parent keeps the expensive one.
- **Let delegates inherit the parent's tools.** Rejected: it makes every
  delegation as dangerous as the session, and a definition is the only place a
  reader can see what a delegate may do.
- **A separate process per delegate.** Real isolation, but it duplicates the
  host connection, provider setup and event plumbing for a bounded worker that
  already runs under host-core containment. Rejected for v1.
- **Flatten delegate rows into the transcript.** Rejected: with parallel
  delegates the interleaving is unreadable, and it implies the parent saw work
  it never saw.
- **Feed delegate messages back into the parent's context.** Rejected: it is
  precisely the cost delegation removes.
- **Definitions in settings/SQLite.** Rejected: definitions are prompts and
  remain Markdown documents on disk. ADR 0112 places user-managed
  definitions under `~/.agents/subagents` so they follow the user across
  repositories without introducing a project capability directory.

## Consequences

- Wide searches, reviews and command runs move out of the session's context at
  the price of one report each.
- A user can add a delegate under `~/.agents/subagents`; no rebuild, no
  settings change, effective on the next prompt when enabled locally.
- Two capability surfaces now exist for the same tools: the session's mode and a
  definition's `tools` list. A delegate can be strictly weaker than its session,
  never stronger.
- The permission UX must handle more than one waiting request, which is visible
  to any user of parallel delegates.
- Delegate rows make transcripts longer on disk; they stay collapsed and out of
  model context, but review and rollback still see them.
