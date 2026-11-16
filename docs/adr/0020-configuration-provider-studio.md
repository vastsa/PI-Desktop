# ADR 0020: Configuration provider studio

- Status: Accepted
- Date: 2026-07-26

## Context

The Agent/Configuration tab housed defaults and providers as stacked settings
rows and a dense always-on form. That layout made readiness hard to scan, buried
the default provider, and made multi-provider management feel like a raw CRUD
form rather than a modern desktop control surface.

## Decision

Settings → Agent/Configuration is presented as a **provider studio**:

1. A compact Defaults card for the default provider/model pair
2. A vendor-account section with one row per OAuth account, including edit, test
   connection, and remove actions
3. A modal OpenAI-compatible add/edit provider composer
4. Card-based provider management with secret badges, thinking presets, test
   connection, make default, and delete

Secrets remain write-only after save. No new settings rail destinations are
introduced.

## Consequences

- Configuration is easier to scan with multiple providers and accounts
- The page keeps one visual hierarchy without a separate summary hero
- Empty and populated states both have clear next actions
- Specs, e2e, and i18n describe the studio presentation
- Future vendor presets can land as composer entry points without changing the
  rail IA

## Alternatives

### Keep the dense stacked form
Rejected because it optimizes for first entry only and degrades once several
providers exist.

### Split Providers back into a rail destination
Rejected because the compact directory intentionally merged Providers into
Agent/Configuration; this redesign improves the existing section instead of
reopening navigation breadth.

## References

- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/08-meta/decisions-log.md` (D107)
- `docs/adr/0013-compact-settings-directory.md`
