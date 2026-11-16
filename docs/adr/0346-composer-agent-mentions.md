# ADR 0346: `@agent` mentions route a turn to a named subagent

- Status: Accepted
- Date: 2026-11-06
- Related: [ADR 0024](0024-composer-commands-and-file-references.md) ·
  [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  issue #986 · prior design in PR #1101 (@f4ct0r)

## Context

A subagent was reachable only when the model decided to call `Task`, so work the
user already knows is separable had no entry point. Everything downstream of
delegation keys off "this turn contains a `Task` call", so the missing piece is an
entry point rather than a second execution path — the shape `/skill:<id>` already
solved.

## Decision

1. **Trigger.** The `@` menu gains an **Agents** group above the file rows, listing
   the `subagentCatalog` that `Task` is built from; accepting a row inserts the same
   atomic inline chip a file gets, serialized to `@name` only at send time with a
   space on either side when a neighbor is not whitespace.
2. **Resolution at send.** Main resolves `@name` tokens against the launch's subagent
   catalog, and a token is a delegation only in Agent mode (ADR 0062 §4), only for a
   catalog subagent, and only when the workspace root holds no file or folder of that
   name; Plan and Goal omit the group.
3. **Prompt.** The model receives a short instruction to call `Task` with the named
   agents followed by the unchanged draft, Skills load before delegation, and a
   leading template or app command keeps its behavior.
4. **Persistence.** The user row stores `command` and
   `agentMentions: [{ start, end, name }]` (UTF-16 offsets) in record meta beside
   `skillMentions`, with no SQL migration.
5. **Transcript.** The typed form renders each validated mention as a chip, and
   offsets that do not point at an `@token` fall back to plain text.
6. **Smart stop.** Without a local draft snapshot, Stop restores a row's `command`
   instead of its `content`, so the composer never receives the model instruction,
   which also corrects the same gap for templates and Skills.

## Consequences

- This is a strong prompt, not an enforced dispatch: enforcing it would need a public
  runtime entry point for a private tool, a new RPC, and a synthetic parent row.
- A failed catalog read only empties the Agents group.
- No IPC, Plugin SDK, or schema-version change; one optional field is added to the
  persisted user message.
