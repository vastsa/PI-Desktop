# ADR 0194: Optional subagent thinking override

- Status: Accepted for implementation
- Date: 2026-09-09
- Deciders: PI-Desktop runtime and UX maintainers
- Related: D356, E2E-203, ADR 0062, ADR 0063, ADR 0144

## Context

The subagent editor previously offered inheritance and explicit thinking levels,
but no way to leave the provider's default untouched. The normal
provider-neutral stream path can translate the agent's `off` state into an
explicit provider setting.

## Decision

1. Subagent frontmatter and input accept `thinkingLevel: omit` in addition to
   the empty inherit value and the seven canonical levels.
2. The runtime represents `omit` as the agent's bookkeeping `off` state, but
   uses pi-ai's low-level stream for the provider request so no provider-neutral
   thinking override is synthesized.
3. Selected model-configuration thinking chips use the accent background and
   inverted primary text in both themes.
4. This is an additive frontmatter/API value.

## Consequences

- Users can distinguish inherit, explicit off, and no provider override.
- Existing definitions remain valid and retain their current behavior.
- Provider adapters remain responsible for deciding their default behavior when
  the subagent selects `omit`.
- The selected chip state is more legible in dark mode while staying aligned
  with the existing accent tokens.
