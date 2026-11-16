# ADR 0012: Universal provider/model coverage via pi-ai + OpenAI-compatible extensibility

- Status: Accepted
- Date: 2026-07-25
- Related: `docs/spec/03-runtime/11-provider-model-system.md`

## Context

Providers must cover market vendors and models broadly rather than a small fixed
set, but maintaining every vendor SDK in-house is unrealistic. pi-ai already
abstracts many providers, and most long-tail vendors expose OpenAI-compatible
APIs.

## Decision

Use pi-ai as the native multi-provider engine and treat OpenAI-compatible
endpoints as first-class. Ship a refreshable model catalog plus user-defined model
ids, do not enforce a closed allowlist, and show major vendors as UI presets while
allowing arbitrary custom endpoints.

## Consequences

- Broad coverage with manageable scope; gateways and local model servers use the
  same path.
- Capability quality varies by vendor, and metadata for obscure models may be
  incomplete or stale.
- Adding a vendor usually needs provider metadata only, not an app change.

## Alternatives

- Fixed list of a few top vendors — rejected: fails the coverage requirement.
- Reimplement every vendor SDK in-house — rejected: duplicates pi-ai and is
  expensive to maintain.
