# ADR 0219: User-Invoked Skills in the Composer Slash Menu

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: D123, D174, ADR 0024, ADR 0039

## Context

D174 established the Skill catalog and local `Skill` tool as a model-invoked
capability, and explicitly rejected user-facing slash commands. That keeps skill
bodies out of the system prompt and preserves the existing permission,
activation, and runtime-reload boundaries, but it also makes active skills
undiscoverable when a user knows that a specific workflow should be applied.

## Decision

1. Active built-in, plugin, and user Skills contribute entries to the composer
   slash menu.
2. Selecting a Skill inserts `/skill:<skill-id> `.
3. Main persists a model-facing instruction asking the model to call the local
   `Skill` tool with each validated id, followed by the remaining user text.
4. No host protocol version or SQL migration is required.

## Consequences

- Users can explicitly discover and invoke an active Skill while the model can
  still choose Skills implicitly from the same catalog.
- A Skill disabled or removed between autocomplete and send falls back to the
  existing literal slash-prompt behavior rather than bypassing activation.
- The final autocomplete group may grow with the active Skill catalog, but its
  stable placement keeps existing command ordering predictable.

## Alternatives considered

- **Inject the Skill body directly into the prompt:** rejected because it
  bypasses the local `Skill` tool's scope checks, on-demand loading, and runtime
  reload semantics.
- **Auto-trigger a Skill from the renderer:** rejected because invocation and
  active-scope validation belong in Electron main, not in a renderer hint.
- **Add a new host protocol or durable message schema:** rejected because the
  existing Electron command channel and optional transcript command metadata are
  sufficient.
