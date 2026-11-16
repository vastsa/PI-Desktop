# ADR: Image generation as a configured Agent capability

- Status: Accepted
- Date: 2026-09-21
- Related: ADR 0101, ADR 0172, ADR 0281;
  [image generation spec](../spec/03-runtime/21-image-generation.md)

## Context

The desktop understands image input and previews but has no image production
path. Users need one selectable image model, conversational generation and
editing, and batches without changing their default chat model, which a Skill
alone cannot execute and pure image endpoints cannot serve as chat adapters.

## Decision

Keep a separate optional settings binding referencing existing provider
credentials, exposing one Agent tool plus a bundled, lazily loaded imagegen skill,
with an independent OpenAI Images adapter and batch scheduler in agent-runtime
while the desktop service coordinates host-owned settings, credentials, contained
source files, and saved output. Because the local-tool shortcut performs no host
permission check, this billable tool obtains host-core authorization through
`tools.execute` before invoking the local service, so host-core never performs
the HTTP call, and local tools gain an abort signal for cancellation, timeout, and
process loss.

## Consequences

- Optional settings preserve stored data and conversation defaults, with no
  schema migration, plugin API change, or direct renderer credential access.
- Partial results stay useful and nothing retries automatically, avoiding
  duplicate paid work, and headless hosts without the image runner do nothing.

## Alternatives

- An independent image workspace: rejected; it would duplicate conversation and
  history ownership.
- A shell or API-only skill: rejected; it would bypass model settings and require
  scripts to handle credentials, files, and retries.
