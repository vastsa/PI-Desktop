# ADR: models.dev owns published model metadata

- Status: Accepted for implementation
- Date: 2026-10-02
- Supersedes: `pi-ai-core-0991-authority.md` for chat model metadata

## Context

PI-Desktop's displayed and effective chat limits came from the pinned pi-ai
catalog. Its sibling models can share adapter defaults such as a 272,000-token
context window even when the selected model's published record has a different
limit.

## Decision

Use models.dev as the source of published chat model limits, modalities,
reasoning metadata, names and prices. Load the bundled snapshot offline and
refresh it explicitly.

OAuth endpoints remain authoritative for which model IDs an account can use. For
each returned ID, enrich metadata from models.dev; do not copy context, output,
reasoning or prices from a pi-ai sibling.

## Consequences

Published model limits now follow the selected models.dev record across
Settings, context budgeting and runtime launch.

## Alternatives

Keeping pi-ai as model metadata authority preserves adapter-adjacent defaults,
but can apply the wrong model's context window to a selected wire model.
