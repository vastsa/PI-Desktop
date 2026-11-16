# ADR 0020: Configuration provider studio

- Status: Accepted
- Date: 2026-07-26
- Related: [ADR 0013](0013-compact-settings-directory.md)

## Context

Agent/Configuration showed defaults and providers as stacked rows and one dense
form, which buried the default provider and felt like a raw CRUD form. Both stay
in that section per ADR 0013, so only presentation and density change.

## Decision

Agent/Configuration becomes a provider studio: a compact Defaults card for the
default provider/model pair, a vendor-account section with one row per OAuth
account offering edit, test connection, and remove, a modal OpenAI-compatible
add/edit composer, and card-based provider management with secret badges,
thinking presets, test connection, make default, and delete. Secrets remain
write-only after save and no new rail destination appears.

## Consequences

- Several providers and accounts stay scannable without a summary hero.
- Empty and populated states both offer a clear next action.
- Vendor presets can later land as composer entries without touching the rail.

## Alternatives

- Keep the dense stacked form: rejected; it only optimizes for first entry.
- Split Providers into its own rail destination: rejected; ADR 0013 merged it
  into Agent/Configuration on purpose.
