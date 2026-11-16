# ADR 0346: `@agent` mentions route a turn to a named subagent

- Status: Accepted
- Date: 2026-11-06
- Deciders: PI-Desktop core
- Related: [ADR 0024](0024-composer-commands-and-file-references.md) ·
  [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [04-ux/08-component-spec §11.8](../spec/04-ux/08-component-spec.md) ·
  issue #986 · prior design in PR #1101 (@f4ct0r)

## Context

A subagent was reachable only when the model decided to call `Task`. Work the
user already knows is separable — "ask the explorer where the retry policy
lives" — had no entry point.

## Decision

1. **Trigger.** `@` already means "reference an entity", so the `@` menu gains
   an **Agents** group above the file rows (each group with its own heading),
   listing the same catalog `Task` is built from (`subagentCatalog`).
2. **Resolution at send.** Main resolves `@name` tokens against the launch's
   subagent catalog.
   - the turn runs in **Agent mode** — the only mode that may execute `Task`
     (ADR 0062 §4); Plan and Goal omit the group and leave a hand-typed mention
     as literal text;
   - it names a catalog subagent; and
   - the local workspace root holds **no file or folder of that name** — a
     project that really has an `explorer` file keeps the file.
3. **Prompt.** The model receives a short instruction to call `Task` with the
   named agents, followed by the unchanged draft (the `@name` tokens stay so
   each brief can be written from the part addressed to it).
4. **Persistence.** The user row stores `command` (typed text) and
   `agentMentions: [{ start, end, name }]` (UTF-16 offsets) in record meta
   beside `skillMentions`.
5. **Transcript.** The typed form renders with each validated mention as a chip
   and the surrounding text as text.
6. **Smart stop.** Without a local draft snapshot, Stop restores a row's
   `command` instead of its `content`, so the composer never receives the model
   instruction.

## Consequences

- This is a strong prompt, not an enforced dispatch — the same trade-off
  `/skill` accepts.
- The `@` menu reads the delegation catalog with the same short TTL as the file
  index; a failed read only empties the Agents group.
- No IPC, Plugin SDK or schema-version change.
