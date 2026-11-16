# ADR 0006: Postpone the plugin marketplace; build the local plugin runtime first

- Status: Accepted
- Date: 2026-07-25

## Context

We need plugin extensibility, and there is a choice between building the
marketplace first or building the local plugin runtime first.

## Decision

1. First complete the **local plugin system** (loading, permissions, commands,
   tools, lifecycle)
2. Treat the **plugin marketplace** as a deferred capability; freeze the
   protocol and data model first
3. The first version of the marketplace only does browse / download /
   verification / manual update, with no transactions or social features

## Rationale

1. Without a stable runtime, the marketplace would only distribute packages that
   cannot run safely
2. Local plugins already satisfy the core "user customization" demand
3. The marketplace involves trust, signing, and a remote supply chain, which are
   significantly more complex

## Consequences

### Positive
- The core path is more stable
- Can be validated first with sample plugins and internal distribution

### Negative
- No one-click store experience in the short term

## Follow-up trigger conditions

Once R1/R2 are complete and the plugin API is basically stable, start R4
Marketplace.
