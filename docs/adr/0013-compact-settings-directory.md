# ADR 0013: Consolidate settings navigation into four destinations

- Status: Superseded in part by ADR 0026
- Date: 2026-07-26

## Context

Baseline 0.4.0 froze a broad Codex-aligned settings rail in D062–D065, with
grouped destinations and many placeholder rows. The shipped local-first
workflows need fewer top-level choices, and changing frozen visual-parity
decisions requires an explicit baseline decision rather than a silent rewrite.

## Decision

Keep the full-page settings shell, Back to app action, search control, rail
metrics, content cards, and theme behavior from D063/D070, and replace the
grouped directory with exactly four destinations in this order: General,
Configuration, Import sessions, About. Appearance becomes a card inside General
and Providers a card inside Configuration, neither as a standalone destination,
and no placeholder destinations render. Provider deep links target the
Providers card; plugin management stays on the app shell's Plugins destination.

## Consequences

- The rail only holds implemented destinations, with theme and provider
  management still reachable as cards.
- The shell and its visual metrics are unchanged.
- Specs and E2E assert the four-item order; D090 supersedes the navigation
  portions of D062–D065 and the Account-specific metric in D070.

## Alternatives

- Keep the broad Codex directory: rejected, empty destinations obscure the
  implemented workflows.
- Drop Appearance or Providers entirely: rejected, both are required product
  capabilities.
