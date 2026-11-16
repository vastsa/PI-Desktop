# ADR 0036: Split Settings into AI and Shortcuts destinations

- Status: Accepted
- Date: 2026-07-30
- Related: D090, D133, D166, ADR 0013, ADR 0026

## Context

ADR 0026 froze a five-destination Settings directory, but Basics accumulated six unrelated
cards — Appearance, Defaults, Permissions, Context management, Keyboard shortcuts,
Developer — burying global AI behavior, which is a runtime concern, beside theme and
language.

## Decision

Keep the Settings shell, Back to app action, search control, rail metrics, content cards,
and theme behavior unchanged, and replace the five-destination rail with seven in this
order: Basics (`general`), AI (`ai`), Shortcuts (`shortcuts`), Model configuration
(`agent`), Import (`import`), Project archive (`projects`), Info (`about`). Permissions and
Context management move from Basics to AI, the Keyboard shortcuts card to Shortcuts, and
Developer to Info, so Basics keeps only Appearance and Defaults and no setting is added,
removed, or renamed. `ai` and `shortcuts` join the `settingsTab` state union and the shared
`SETTINGS_NAV` search index, so Settings search and deep links resolve them and relocated
rows are indexed under their new destination, while provider setup deep links still target
Model configuration.

## Consequences

- Basics is short and look-and-feel only; AI behavior, shortcuts, and developer controls
  are one click away.
- D133/ADR 0026 is superseded for destination count and order only; no IPC, host RPC,
  storage, or security contract changes.
- Specs and E2E scenarios asserting the five-item rail order, including the reversed "no
  Keyboard destination" assertion, must adopt the seven-item order.

## Alternatives

- Keep all six cards in Basics: a long page mixing appearance with AI policy.
- Merge AI behavior into Model configuration: that page owns connection identity, not
  runtime behavior.
