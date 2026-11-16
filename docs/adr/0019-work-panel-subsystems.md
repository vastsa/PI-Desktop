# ADR 0019: Work panel subsystems (embedded browser, git review, file browsing)

- Status: Superseded in part by ADR 0108 and ADR 0170
- Date: 2026-07-26
- Related: [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md)

## Context

The work panel docks workspace review, browser preview, file browsing, and, once,
an interactive shell beside the conversation. The sandboxed renderer cannot do
workspace or window work itself, so each surface needs a host-owned boundary.

## Decision

1. **Browser.** Bundled plugin `pi.browser` provides Chrome and agent CDP
   (ADR 0170); Electron Main owns the guest `WebContentsView`, navigation and
   popup policy, permission denial, and bounds clamping.
2. **Review.** Review snapshots and guarded rollback open only on explicit user
   action, never from a tool result (D451).
3. **Files.** Project browsing is the bundled `pi.files` plugin over the public
   contributed-view and filesystem APIs.
4. **Transcript resources.** File and URL artifacts stay session-scoped tabs.

The interactive terminal is gone (ADR 0108); Agent Bash is an independent
non-interactive tool.

## Consequences

- Native surfaces keep their bounds rules and the renderer stays sandboxed.
- Review and artifacts keep conversation ownership; browsing is a plugin.

## Alternatives considered

- Every surface as an agent tool: rejected; browsing and review would inherit
  agent permissions.
- Private host capabilities for bundled plugins: rejected; it bypasses the public
  plugin boundary.
