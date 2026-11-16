# ADR: Image generation as a configured Agent capability

- Status: Accepted
- Date: 2026-09-21
- Related: ADR 0281, ADR 0101, ADR 0172; [image generation spec](../spec/03-runtime/21-image-generation.md)

## Context

The desktop understands image input and previews but has no image production
path. Users need one selectable image model, conversational generation/editing,
and batches without changing their default chat model.

## Decision

Keep a separate optional settings binding referencing existing provider
credentials. Expose one Agent tool plus a bundled, lazily loaded imagegen skill.

The existing local-tool shortcut does not perform host permission checks. For
this billable tool, the bridge must obtain host-core authorization through
`tools.execute` before invoking the local service.

## Alternatives and consequences

- An independent image workspace would duplicate conversation/history ownership;
  use existing chat and previews first.
- A shell/API-only skill would bypass model settings and require scripts to
  handle credentials, files and retries.
- A broad multi-protocol framework is unnecessary for the requested single
  Images protocol.
- Optional settings preserve existing stored data and conversation defaults.
