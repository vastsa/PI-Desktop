# ADR 0219: User-Invoked Skills in the Composer Slash Menu

- Status: Accepted
- Date: 2026-09-11
- Related: D123, D174, ADR 0024, ADR 0039

## Context

D174 made the Skill catalog and the local `Skill` tool model-invoked and rejected
user-facing slash commands, which keeps bodies out of the system prompt and preserves
permission and activation boundaries, but leaves an active skill undiscoverable to a
user who knows a workflow should apply.

## Decision

Active built-in, plugin, and user Skills contribute entries to the composer slash menu
in a trailing `Skills` group, named with the explicit `skill:<id>` prefix while
`skillId` keeps the original id. Selecting one inserts `/skill:<skill-id> `, and
sending uses the ordinary prompt path: Electron main resolves the command against the
session project, revalidates active scope and permissions at send time, and keeps the
typed slash form for the transcript chip. Main then persists a model-facing
instruction to call the local `Skill` tool with each validated id before the remaining
user text, so the body loads on demand and never reaches the renderer or the prompt.
No host protocol version or SQL migration is needed: optional `command` and
`skillMentions` transcript metadata keep the typed text across reloads, the additive
command contract permits `kind: "skill"` and `skillId`, and catalog, body-size, and
runtime-reuse boundaries stay those of D174 and ADR 0039.

## Consequences

- Users can invoke an active Skill explicitly while the model still chooses Skills
  implicitly from the same catalog.
- A Skill disabled between autocomplete and send falls back to the literal slash
  prompt instead of bypassing activation.

## Alternatives

- Inject the Skill body into the prompt: bypasses scope checks and reload semantics.
- Auto-trigger from the renderer: scope validation belongs in Electron main.
