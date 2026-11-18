# ADR 0186: Summarize First-Turn Session Titles with a Main-Owned One-Shot

- Status: Superseded by ADR 0323
- Date: 2026-09-08

## Context

A first prompt needs an immediate sidebar label, but a raw truncated prompt is
noisy and can obscure the task topic. A summary had to use the session's own
provider and model without moving model execution into the renderer.

## Decision (historical)

After `agent_end`, the renderer called the allowlisted
`session/summarizeTitle` IPC; Electron validated the session and prompt,
resolved the effective provider/model, and ran `summarizeSessionTitle` with
thinking disabled, leaving the deterministic first-prompt fallback in place on an
empty or failed completion and persisting a valid result through `session.rename`.
Renderer-local metadata persisted `manualTitle`, so a manual or
fallback-owned title was never overwritten.

## Superseded

ADR 0323 replaced this main-owned one-shot title summary. D654 later restored the
first-prompt fallback as a host-owned write; only the one-shot completion stays
removed.
