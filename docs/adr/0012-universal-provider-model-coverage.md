# ADR 0012: Universal provider/model coverage via pi-ai + OpenAI-compatible extensibility

- Status: Accepted
- Date: 2026-07-25

## Context

Product requirement:

> Provider support must cover market vendors/models broadly, not a small fixed set.

## Decision

1. Use **pi-ai** as the native multi-provider engine
2. Treat **OpenAI-compatible providers** as first-class
3. Ship a **refreshable model catalog** + **user-defined model IDs**
4. Do **not** enforce a closed product allowlist that blocks unknown models
5. Expose major vendors in UI presets, while allowing arbitrary custom endpoints

## Consequences

### Positive
- Broad market coverage with manageable engineering scope
- Practical path to "support market vendors/models"
- Native quality where pi-ai has integrations
- Easy support for gateways and local model servers
- Universal escape hatch for everything else

### Negative / tradeoffs
- Capability quality differs by vendor
- Catalog/capability metadata may be incomplete (especially for obscure models)
  and needs refresh/manual overrides
- OpenAI-compatible quirks still need compatibility flags
- Catalog freshness depends on refresh/bundled snapshots

## Alternatives considered

1. **Tiny fixed vendor list only** (e.g., only 3-4 top vendors)
   - Rejected: fails globalization and user expectation
2. **Build and maintain all vendor SDKs ourselves** (e.g., reimplement every
   vendor SDK in Rust)
   - Rejected: duplicates pi-ai, slows delivery, high maintenance
3. **Only OpenAI-compatible, no native providers**
   - Rejected: worse UX/quality for major vendors with native quirks
4. **Hardcoded closed/fixed model allowlist**
   - Rejected: models churn weekly; blocks power users

## Follow-up specs

- `docs/spec/03-runtime/11-provider-model-system.md`
- `docs/spec/03-runtime/12-provider-config-schema.md`
- `docs/spec/03-runtime/13-model-catalog-and-selection.md`
