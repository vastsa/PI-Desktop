# ADR: models.dev owns published model metadata

- Status: Accepted for implementation
- Date: 2026-10-02
- Supersedes: `pi-ai-core-0991-authority.md` for chat model metadata

## Context

PI-Desktop's displayed and effective chat limits came from the pinned pi-ai
catalog. Its sibling models can share adapter defaults such as a 272,000-token
context window even when the selected model's published record has a different
limit. This affects Settings, the context inspector, session launch and
compaction budgets.

The repository already carries a reviewed models.dev snapshot and matching
logic that prefers the selected official publisher, then accepts other
publishers only when their matching records agree. It leaves ambiguous matches
generic instead of selecting an arbitrary reseller record. The historical
shipped-publisher set has 38 distinct preset vendor keys (40 after aliases),
not a verifiable fixed set of 39; the implementation therefore uses the
repository's provider and endpoint identities rather than claiming an
unsupported count.

## Decision

Use models.dev as the source of published chat model limits, modalities,
reasoning metadata, names and prices. Load the bundled snapshot offline and
refresh it explicitly. Resolve the selected publisher first; when no official
record matches, use a non-official publisher record only when the resolver can
establish a safe, unambiguous match. Otherwise retain the generic shape.

OAuth endpoints remain authoritative for which model IDs an account can use.
For each returned ID, enrich metadata from models.dev; do not copy context,
output, reasoning or prices from a pi-ai sibling. Preserve explicit per-account
binding overrides. Keep pi-ai for provider discovery/identity, OAuth and
transport, and typed non-chat operations that models.dev does not represent.

## Consequences

Published model limits now follow the selected models.dev record across
Settings, context budgeting and runtime launch. A missing or ambiguous record
stays generic and does not invent metadata. No provider credentials are sent
to models.dev, and no stored provider data, host protocol or database schema
changes.

## Alternatives

Keeping pi-ai as model metadata authority preserves adapter-adjacent defaults,
but can apply the wrong model's context window to a selected wire model.
Using models.dev as a browsable model list would expose models that an endpoint
does not serve or an account is not entitled to, so live endpoint/account IDs
remain the selection boundary.
