# ADR 0097: Place global defaults under the AI settings destination

- Status: Accepted
- Date: 2026-08-18
- Related: D166, D238, D239, ADR 0096

## Context

The flat Settings directory removed redundant navigation levels, but the Basics
page still owned a Defaults card holding the default operating mode, command
shell, and Enter-to-send preference: agent behavior controls sitting beside
appearance controls.

## Decision

Keep the eight-destination Settings directory. Basics owns Appearance and
platform-supported close behavior; the **全局 AI / AI** destination owns
Permissions and the Defaults card with default operating mode (Agent / Plan /
Goal), command shell selection with its host-backed fallback status, and
Enter-to-send. Model configuration keeps the default provider/model selector
because it is coupled to provider readiness and model identity. Only renderer
content and Settings search ownership move; persisted settings, host APIs,
runtime semantics, and deep links do not change.

## Consequences

- Basics has a focused visual and application-preference scope.
- Settings search routes mode, command shell, and Enter-to-send queries to AI.
- Persisted settings and runtime behavior are unchanged.

## Alternatives

- Keep Defaults in Basics: rejected, it mixes appearance with agent behavior.
- Add a Behavior destination: rejected, it expands the directory for three
  controls that already have an owner.
