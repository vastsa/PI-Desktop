# ADR: Image generation as a configured Agent capability

- Status: Accepted
- Date: 2026-09-21
- Related: ADR 0281, ADR 0101, ADR 0172; [image generation spec](../spec/03-runtime/21-image-generation.md)

## Context

The desktop understands image input and previews but has no image production
path. Users need one selectable image model, conversational generation/editing,
and batches without changing their default chat model. A Skill alone cannot
execute image requests. Pure image endpoints cannot be treated as chat adapters.

## Decision

Keep a separate optional settings binding referencing existing provider credentials.
Expose one Agent tool plus a bundled, lazily loaded imagegen skill. Use an independent
OpenAI Images adapter and batch scheduler in agent-runtime; the desktop service
coordinates host-owned settings/credentials, contained source files and saved output.
Renderer code handles configuration, previews and navigation only.

The existing local-tool shortcut does not perform host permission checks. For this
billable tool, the bridge must obtain host-core authorization through `tools.execute`
before invoking the local service. Host-core never performs the HTTP call; its
result is authorization, while the sidecar result records actual generated files.
Local tools gain an abort signal so this path can stop requests on cancellation,
timeout and process loss. Existing tools retain their deadlines and behavior.

## Alternatives and consequences

- An independent image workspace would duplicate conversation/history ownership;
  use existing chat and previews first.
- A shell/API-only skill would bypass model settings and require scripts to handle
  credentials, files and retries. The skill instead calls the bounded host tool.
- A broad multi-protocol framework is unnecessary for the requested single Images
  protocol. Generation and multipart editing share its adapter and scheduler.
- Optional settings preserve existing stored data and conversation defaults. No
  schema migration, plugin API change or direct renderer credential access occurs.
- Partial results remain useful; no automatic retry avoids duplicate paid work.
  Upstream model support and billing remain provider responsibilities.
- Headless hosts without the desktop image runner do not perform image requests.
