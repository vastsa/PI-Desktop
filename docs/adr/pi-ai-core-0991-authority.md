# ADR: Pi 0.99.1 account model authority

- Status: Superseded for chat model metadata by [models.dev catalog authority](models-dev-catalog-authority.md)
- Date: 2026-09-30
- Supersedes: ADR 0134 model metadata source

## Context

The authorized migration targets pi-ai and pi-agent-core, and Pi 0.99.1 exposes
typed Models operations, provider refresh/filter hooks, and native thinking
metadata; a second executable catalog would disagree about limits, entitlement, and
pricing, while accounts and persistence stay Host-owned and plugins keep their SDK
and lifecycle.

## Decision

Use Pi Providers/Models as the published model authority: one Models collection per
account, Host credential storage, an explicit Desktop binding projection, ambient
auth disabled at catalog startup, OAuth live discovery inside the same
refresh/filter boundary, raw published metadata separate from user overrides, and
images routed through `generateImages`. Non-chat settings keep a display-only
metadata supplement that grants no authentication, dispatch, pricing, or
entitlement, unknown relay matches cannot rewrite wire IDs, and the independent
release-catalog fetch and packaging resource are removed.

Usage is attributed to physical operation identities, replayed records aggregate
once, unknown costs stay unknown, and `pi-coding-agent` remains only the compaction
and file compatibility dependency rather than the owner of `AgentSession`, Codemod,
or virtual routing ([design review](../project/pi-coding-agent-design-review.md)).

## Consequences

- The adapter reuses Desktop's boundaries and saved data with a small display-only
  gap, catalog changes follow reviewed Pi pins, and the usage ledger needs no
  migration because it reuses the turns usage JSON with optional provenance fields.
- The harness APIs kept during the first migration were later removed: the runtime
  owns transcript projection, estimation, checkpoint preparation, and summary
  generation, host-core stays the durable session owner, and `pi-coding-agent` is
  limited to native Pi session continuation and the trusted-extension shim
  (`02-architecture/06-pi-runtime-dependency-boundary.md`).

## Alternatives

- Retaining models.dev as executable authority: duplicates Pi's metadata and refresh
  semantics.
- Adopting ModelRuntime/AgentSession: adds another account and session owner.
