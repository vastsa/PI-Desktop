# ADR: Pi 0.99.1 account model authority

- Status: Accepted for the current migration candidate
- Date: 2026-09-30
- Supersedes: ADR 0134 model metadata source

## Context

The authorized migration targets pi-ai and pi-agent-core. Pi 0.99.1 exposes typed
Models operations, provider refresh/filter hooks and native thinking metadata.
Keeping a second executable catalog alongside them creates inconsistent limits,
account entitlement and pricing. Desktop accounts and persistence remain owned
by Host; Desktop plugins retain their SDK and lifecycle.

## Decision

Use Pi Providers/Models as the published model authority. Maintain one Models
collection per account, with Host credential storage and explicit Desktop binding
projection. Disable ambient auth for catalog startup. Put OAuth live discovery
inside the same provider refresh/filter boundary. Keep raw published metadata
separate from effective user overrides. Route images through generateImages with
a registered compatible adapter where a native provider operation is absent.

Preserve non-chat settings visibility with a display-only metadata supplement;
it must not provide authentication, dispatch, pricing or entitlement. Unknown
relay matches remain conservative and cannot rewrite physical wire IDs. Remove
the independent release catalog fetch and packaging resource.

Attribute usage to physical operation identities through runtime, events and
Host persistence. Aggregate replayed records once and retain unknown costs as
unknown. Immediate nested-tool parent and owning Task are separate fields.

Keep pi-coding-agent as the existing compaction/file compatibility dependency.
Do not adopt its AgentSession, Codemode, tool composition or virtual routing as
part of this migration. Their reusable designs and adoption conditions are
recorded in [the design review](../project/pi-coding-agent-design-review.md).

## Alternatives

Retaining models.dev as executable authority would require duplicating Pi's
operation metadata and refresh semantics. Adopting ModelRuntime/AgentSession
would introduce another account/session owner and impede later removal.

## Consequences

The account adapter reuses Desktop's existing boundaries and preserves saved data,
with a small explicit display-only compatibility gap. Catalog changes now track
reviewed Pi pins. No schema migration is needed for the usage ledger: it uses the
existing turns usage JSON with optional compatible provenance fields.
