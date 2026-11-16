# ADR: Pi 0.99.1 account model authority

- Status: Superseded for chat model metadata by [models.dev catalog authority](models-dev-catalog-authority.md)
- Date: 2026-09-30
- Supersedes: ADR 0134 model metadata source

## Context

The authorized migration targets pi-ai and pi-agent-core. Pi 0.99.1 exposes
typed Models operations, provider refresh/filter hooks and native thinking
metadata.

## Decision

Use Pi Providers/Models as the published model authority. Maintain one Models
collection per account, with Host credential storage and explicit Desktop
binding projection.

Preserve non-chat settings visibility with a display-only metadata supplement;
it must not provide authentication, dispatch, pricing or entitlement. Unknown
relay matches remain conservative and cannot rewrite physical wire IDs.

## Alternatives

Retaining models.dev as executable authority would require duplicating Pi's
operation metadata and refresh semantics.

## Consequences

The account adapter reuses Desktop's existing boundaries and preserves saved
data, with a small explicit display-only compatibility gap.

### Implementation note (2026-10-03)

The 0.99.1 migration initially retained pi-coding-agent for compaction and file
compatibility.
