# ADR 0186: Summarize First-Turn Session Titles with a Main-Owned One-Shot

- Status: Superseded by ADR 0323
- Date: 2026-09-08

## Context

A first prompt currently needs an immediate sidebar label, but a raw truncated
prompt is noisy and can obscure the task's topic.

## Decision (historical)

Keep the normalized first-prompt fallback synchronous from the renderer's point
of view. (D654 later restored that fallback as a host-owned write; only the
one-shot completion below stays removed.) After the initial turn emits
`agent_end`, the renderer calls the allowlisted `session/summarizeTitle` IPC.

## Consequences

Superseded (Superseded by ADR 0323). The full record is in git history.
