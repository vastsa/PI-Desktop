# ADR: models.dev owns published model metadata

- Status: Accepted for implementation; supersedes `pi-ai-core-0991-authority.md`
- Date: 2026-10-02

## Context

Displayed and effective chat limits came from the pinned pi-ai catalog, where sibling
models share adapter defaults even when the selected model's published record
differs. A reviewed models.dev snapshot and matching logic already exist.

## Decision

models.dev is the source of published chat model limits, modalities, reasoning
metadata, names, and prices, and the resolver prefers the selected publisher before a
safe unambiguous match and otherwise keeps the generic shape. OAuth endpoints stay
authoritative for which model IDs an account may use, and each returned ID is enriched
from models.dev instead of copying values from a pi-ai sibling, while explicit
per-account binding overrides are preserved. pi-ai keeps provider discovery and
identity, OAuth and transport, and typed non-chat operations.

## Consequences

- Published limits follow the models.dev record across Settings, context budgeting,
  and runtime launch; a missing or ambiguous record stays generic.
- No credentials reach models.dev, and no stored data, protocol, or schema changes.

## Alternatives

- Keep pi-ai as authority: can apply the wrong model's context window.
- Browse models.dev as the model list: exposes models an endpoint does not serve.
