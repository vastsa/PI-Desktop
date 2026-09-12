# ADR 0186: Summarize First-Turn Session Titles with a Main-Owned One-Shot

- Status: Accepted
- Date: 2026-09-08

## Context

A first prompt currently needs an immediate sidebar label, but a raw truncated
prompt is noisy and can obscure the task's topic. The title summary must use the
same provider/model as the session without moving model execution into the
renderer or changing host-owned session storage.

## Decision

Keep the normalized first-prompt fallback synchronous from the renderer's point
of view. After the initial turn emits `agent_end`, the renderer calls the
allowlisted `session/summarizeTitle` IPC. Electron validates the session and
prompt, resolves the session's effective provider/model, and invokes the
agent-runtime `summarizeSessionTitle` one-shot with thinking disabled. The
runtime sanitizes the response and an empty or failed completion leaves the
fallback unchanged. The renderer persists a valid result through the existing
`session.rename` path.

Renderer-local session metadata persists `manualTitle`. The automatic path also
refuses to run for a persisted title that is neither a recognized default nor
the deterministic first-prompt fallback. This protects manual titles made
before the marker existed and prevents a completed summary from being replaced
on a later renderer restart. No host RPC or storage schema version changes.

## Consequences

- New sessions get immediate, readable fallback labels and a concise background
  summary when the configured provider succeeds.
- Manual titles remain authoritative across renderer restart.
- Provider failures cannot block or fail the conversation turn.
- The title-summary IPC is main-owned and cannot expose provider credentials or
  model execution to the renderer.

## Alternatives considered

- Run the one-shot in the renderer: rejected because provider resolution and
  credentials belong to Electron main and the sidecar.
- Wait for the summary before submitting the prompt: rejected because it adds
  visible latency to every first turn.
- Add a host schema column for title origin: deferred; persisted renderer
  metadata plus the title/fallback guard covers existing and new sessions
  without a storage migration.
