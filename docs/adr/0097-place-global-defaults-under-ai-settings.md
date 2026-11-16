# ADR 0097: Place global defaults under the AI settings destination

- Status: Accepted
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D166, D238, D239, ADR 0096

## Context

The flat Settings directory removed redundant navigation levels, but the Basics
page still owned a Defaults card containing the default operating mode, command
shell, and Enter-to-send preference. These controls change agent behavior rather
than application appearance, so their location made the Basics page mix visual
preferences with global AI behavior.

## Decision

Keep the eight-destination Settings directory unchanged. Basics owns the
Appearance card and platform-supported close behavior.

- default operating mode (Agent / Plan / Goal)
- command shell selection and its host-backed fallback status
- Enter-to-send

The Model configuration destination continues to own the default provider/model
selector because it is coupled to provider readiness and model identity. This
change only moves renderer content and Settings search ownership; persisted
settings, host APIs, runtime semantics, and deep-link contracts do not change.

## Consequences

- Basics has a focused visual and application-preference scope.
- Global AI presents the behavior controls users expect to affect agent turns.
- Settings search routes mode, command shell, and Enter-to-send queries to AI.
- Existing persisted settings and runtime behavior remain unchanged.

## Alternatives

### Keep Defaults in Basics

Rejected because the card mixes appearance with agent execution behavior.

### Add a separate Behavior destination

Rejected because it would expand the flat directory for three closely related
controls that already have a clear owner in AI.

### Move the controls to Model configuration

Rejected because operating mode, command shell, and Enter-to-send are global
interaction behavior and do not depend on provider/model readiness.

## References

- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
