# ADR 0019: Work panel subsystems (embedded browser, git review, file browsing)

- Status: Superseded in part by ADR 0108 and ADR 0170
- Date: 2026-07-26
- Deciders: PI-Desktop maintainers
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [01-ipc-protocol §13a](../spec/03-runtime/01-ipc-protocol.md) ·
  [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md)

## Context

The work panel was introduced as a docked surface for workspace review,
embedded browser preview, file browsing, and an interactive shell. Each surface
needed a host-owned boundary because the sandboxed renderer could not safely
perform workspace or window operations itself.

## Decision

The retained work-panel subsystems are:

1. **Browser.** Chrome and agent CDP ship as bundled plugin `pi.browser`
   (ADR 0170). Electron Main still owns the guest `WebContentsView`,
   navigation policy, permission denial, external popup handling, and
   measured bounds clamp.
2. **Review.** Message-owned review snapshots and guarded rollback remain
   host-integrated surfaces opened by successful workspace Write/Edit artifacts.
3. **Files.** Project browsing is supplied by the bundled `pi.files` plugin over
   the public contributed-view and filesystem APIs.
4. **Transcript resources.** File and URL artifacts remain session-scoped tabs
   opened by the conversation rather than generic launchers.

The former interactive-terminal subsystem is not part of the current product.
Its removal, including the desktop IPC and packaging cleanup, is defined by
ADR 0108. Agent Bash is an independent non-interactive agent tool and is not a
work-panel subsystem.

## Consequences

- The renderer remains sandboxed and native Browser/plugin surfaces continue to
  use the existing measured-bounds and visibility rules.
- Review and file artifacts retain conversation ownership, while project
  browsing uses the bundled Files plugin.
- Interactive shell access is provided by an external terminal rather than by a
  PI-Desktop work-panel tab.

## Alternatives considered

- Making every panel surface an agent tool was rejected because user-driven
  browsing and review would inherit agent permissions, truncation, and audit
  semantics.
- Giving bundled plugins private host capabilities was rejected because it
  would bypass the public plugin boundary.
- Keeping the former interactive shell was rejected by ADR 0108 to remove its
  separate native and lifecycle surface.
