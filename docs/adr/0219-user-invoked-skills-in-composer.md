# ADR 0219: User-Invoked Skills in the Composer Slash Menu

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: D123, D174, ADR 0024, ADR 0039

## Context

D174 established the Skill catalog and local `Skill` tool as a model-invoked
capability, and explicitly rejected user-facing slash commands. That keeps
skill bodies out of the system prompt and preserves the existing permission,
activation, and runtime-reload boundaries, but it also makes active skills
undiscoverable when a user knows that a specific workflow should be applied.

The composer already merges several command sources through an Electron-only
channel. It can expose a user-invoked entry without moving skill bodies into
the renderer, prompt, or host protocol.

## Decision

1. Active built-in, plugin, and user Skills contribute entries to the composer
   slash menu. They appear in a separate `Skills` group after extension
   commands; the group is always last. The exact skill id is the slash name.
   Existing command names win collisions, so a Skill cannot shadow a template,
   builtin, plugin, or extension command.
2. Selecting a Skill inserts `/<skill-id> `. Sending follows the ordinary
   prompt path. Electron main resolves the command against the current session
   project, revalidates its active scope and permissions at send time, and
   keeps the typed slash form for the transcript chip.
3. Main persists a model-facing instruction asking the model to call the local
   `Skill` tool with the validated id, followed by any user body text. The Skill
   body is still loaded on demand by that tool; it is not sent to the renderer
   or injected directly into the prompt. `agent.prompt.inject` and existing
   user-Skill activation rules remain authoritative.
4. No host protocol or storage schema changes are required. The additive
   command contract permits `kind: "skill"` and `skillId`, and the existing
   composer-command IPC response carries the extra entries. Skill catalog,
   body-size, path, and runtime-reuse boundaries remain those of D174 and
   ADR 0039.

## Consequences

- Users can explicitly discover and invoke an active Skill while the model can
  still choose Skills implicitly from the same catalog.
- A Skill disabled or removed between autocomplete and send falls back to the
  existing literal slash-prompt behavior rather than bypassing activation.
- The final autocomplete group may grow with the active Skill catalog, but its
  stable placement keeps existing command ordering predictable.

## Alternatives considered

- **Inject the Skill body directly into the prompt:** rejected because it
  bypasses the local `Skill` tool's scope checks, on-demand loading, and
  runtime reload semantics.
- **Auto-trigger a Skill from the renderer:** rejected because invocation and
  active-scope validation belong in Electron main, not in a renderer hint.
- **Add a new host protocol or durable message schema:** rejected because the
  existing Electron command channel and optional transcript command metadata
  are sufficient.
