# ADR 0308: User-authored `@agent` delegation

- Status: Accepted for implementation
- Date: 2026-09-26
- Deciders: PI-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0024](0024-composer-commands-and-file-references.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0270](0270-builtin-subagents-can-be-disabled.md) ·
  [ADR 0279](0279-resumable-subagent-delegations.md) ·
  [ADR 0299](0299-subagent-context-budget.md) ·
  [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) §11.8
- Tracking: #986

## Context

A user could reach a subagent only when the model chose to call `Task`. That
decision belongs to the model, which is correct for work it recognizes as
parallelizable and wrong for work the user already knows is separable: "ask the
explorer where the retry policy lives" is an instruction, not a request to be
negotiated. Until now there was no user-side entry point at all.

The delegation machinery itself was already complete and already had one
implementation. `Task` is built in
`packages/agent-runtime/src/runtime.ts` from `loadSubagentDefinitions`, and
everything downstream — the delegation card and topology (ADR 0062 §6), the
permission request queue (§7), `TaskWait` / `TaskList` / `TaskStop`,
resumable delegates (ADR 0279), the context budget (ADR 0299), model pins and
fallbacks, builtin activation (ADR 0270) — keys off "this turn contains a `Task`
call". None of it asks who initiated it.

The composer already had a working precedent for exactly this shape. `/skill`
lets a user invoke a skill, and Electron main rewrites the typed form into a
short model instruction that makes the existing `Skill` tool call explicit,
while the user's own text stays in the transcript as a chip (ADR 0024).

## Decision

Extend the `@` trigger, which already means "reference an entity", to cover
agents alongside files. A user types `@explorer`, picks the delegate from the
menu, and continues the same draft as the brief. The two kinds are separate
sections, each with its own heading: leaving the file rows unlabelled under the
delegate heading made them read as part of it, which is the one arrangement that
would be ambiguous at a glance.

At send time main rewrites the draft into an explicit `Task` instruction plus
the user's own words, and keeps the original draft as the transcript's
`command` — the same arrangement `/skill` already uses:

```text
Call the `Task` tool with the agent below before answering this request. …

帮我看看认证模块
```

The delegation catalog is read from the existing
`loadSubagentDefinitions` merge, now factored into
`electron/main/subagent-catalog.ts` so the settings page, the composer menu and
the prompt path cannot disagree about which handles exist. No new IPC channel
was added: `composerCommands` gained an `agents` array beside its `commands`.

### The file/agent ambiguity is resolved in favour of the file

Both a file reference and an agent mention serialize to an `@token`, so a
workspace that really contains a file called `explorer` makes `@explorer`
legitimately both things. `findAgentMentions` therefore treats a token as an
agent only when it names a catalog entry **and** the workspace file index holds
no path of that name. A user who meant the file gets the file; a user who meant
the delegate, in a project that has no such file, gets the delegate.

Only bare tokens qualify: a token carrying `/` or a quote is a path, and
subagent names are `[a-z0-9-]` by contract, so nothing a user can mean as a
delegate is lost.

### A delegate is one atomic mention in the draft

Accepting an agent creates the same inline chip a completed file reference
creates, carrying the bot badge. A delegate is a single thing the user picked;
leaving it as editable `@name` text let a keystroke cut it into `@explo`, which
is both a broken mention and a half-typed handle the resolver would not accept.
`contentEditable=false` is what makes deletion atomic.

The chip serializes back to `@name`, and needs a leading space when text
precedes it. The send-time resolver deliberately reads an `@token` only at a
start or after whitespace — that is what stops `user@host` from looking like a
mention — so `look@explorer` would have produced a token the resolver ignored
and a delegation that silently did not happen. File output is unchanged
byte-for-byte; only the agent branch gained a separator.

The mention's `path` is the `Task` handle, not a location, so `kind` is the
discriminant that keeps a delegate off the attachment path in both the
optimistic transcript row and the prompt builder, and off the image path on
draft restore. A delegate is never handed to the host to read.

### Delegation is offered in Agent mode only

`Task` is registered only when the runtime mode is `agent` (ADR 0062 §4). Plan
and Goal are read-only contract negotiations, and a delegate holding Bash or
Edit would drive straight through one. The menu therefore omits the group
outside Agent mode, and a hand-typed `@explorer` sent from Plan or Goal is
**refused** with a toast rather than silently delivered as ordinary text — the
same fail-closed shape an unreadable command source already uses (issue #795).
The draft survives the refusal for retry after switching modes.

### Not done here

- **Transcript rendering** chips each named delegate, the way a file reference
  is chipped. `agentMentions` is recorded on the message when the turn is sent
  and persisted through host-core's `ui_to_record` / `record_to_ui`, mirroring
  `skillMentions`. Recording rather than re-resolving on render is the same
  durability skills already have: a message sent while a delegate existed keeps
  its chip after that delegate is removed. A stored range that does not line up
  with the text falls back to the whole draft, so a bad offset cannot drop or
  duplicate characters.
- **Enforced dispatch** — starting a delegate without the model's involvement —
  is explicitly out of scope. It would require a public runtime entry point for
  the currently private `buildSubagentTool().execute`, a sidecar RPC, an IPC
  channel, and a synthetic parent tool row so the transcript topology still
  matches ADR 0062 §6. It also has a real cost: `resumeAfterDelegations`
  injects a delegate's report into the parent agent's context unconditionally,
  so a parent would receive a delegation it never asked for. That warrants its
  own ADR.

## Consequences

- Delegation gains a user entry point without a second delegation
  implementation, a new IPC surface, or any change to host-core, the
  persistence schema, or the `Task` tool contract.
- The routing is a strong prompt, not an enforced dispatch. The model may
  still answer `@explorer …` itself. This is the identical trade-off ADR 0024
  accepted for `/skill`, and it is the reason the refusal in Plan/Goal is worth
  the effort: a silently mis-routed delegation is worse than a visible one.
- The file/agent collision is decided by a rule rather than by UI, so a user in
  a project containing a file named after a delegate cannot route to that
  delegate from the composer. The rule is documented and unit-tested; a
  disambiguating syntax can revisit it if the collision proves common.
- `@agent` is a distinct mention from a file reference at the type level
  (`ComposerAgent` beside `ComposerCommand`), so a subagent sharing a name with
  a skill or a `/` command cannot displace it.
