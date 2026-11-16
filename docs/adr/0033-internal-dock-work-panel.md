# ADR 0033: Internal-dock work panel (no native window expansion)

- Status: Superseded by ADR 0122; internal-dock direction restored by ADR 0151
- Date: 2026-07-30
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D163
- Supersedes in part: ADR 0032

## Context

ADR 0032 made the work panel a docked flex column but, to keep the chat width
stable, reserved *native window width* equal to the panel's committed width.

- The former interactive terminal tab did not use a native view; ADR 0108
  removes that surface entirely.
- Native `WebContentsView`s (the host browser guest and plugin views) are
  positioned from the **renderer-measured** panel rect via `setBounds` (see
  `BrowserPane.setBounds` and `PluginViewTab`).

## Decision

1. The work panel is a fixed-width in-flow flex column inside the **fixed**
   client area. Opening it reflows `MainChat` to the left; it never expands the
   OS window.

## Consequences

Superseded (Superseded by ADR 0122; internal-dock direction restored by ADR 0151). The full record is in git history.
