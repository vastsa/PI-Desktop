# ADR 0028: Scope work-panel runtime contexts to conversations

- Status: Accepted
- Date: 2026-07-27
- Amended in part by: [ADR 0108](0108-remove-built-in-interactive-terminal.md)

## Context

The renderer owned one global work-panel tab set, and D128 required that selecting
another conversation or workspace close the panel and destroy every tab, which
discarded useful tools on return. It also raced with permission-gated tools: an
artifact finishing during a switch either flashed the panel open and closed or was
dropped by the background-session guard, and BrowserPreview could resolve a
relative path against the visible workspace instead of its own.

## Decision

Each conversation owns a renderer-memory work-panel context: open state, ordered
tabs, active tab, file request, and Browser resource.

- Switching conversations saves the current projection and atomically restores
  the destination one; switching away never deletes either, and deleting a
  conversation drops its context. Contexts stay transient, so only panel width
  survives relaunch.
- Review and BrowserPreview artifacts are recorded against their originating
  `sessionId`, including in the background, and background artifacts update
  retained state only — never opening, activating, navigating, resizing, or
  focusing the visible panel.
- BrowserPreview events carry `sessionId`; Electron Main resolves local preview
  paths from that durable session's `projectPath` and navigates only when the
  originating conversation's Browser tab is visible.

This adopts D142 and supersedes only D128's requirement to close and clear tabs on
visible session or workspace changes; D128's artifact triggers, deduplication, and
close rules remain, with its no-launcher rule amended by ADR 0068.

## Consequences

- Returning to a conversation restores its tools without reinterpreting paths.
- Permission completion no longer flashes the panel or loses the artifact.
- Bounded per-session UI state is retained without new storage or migration.

## Alternatives

- Keep clearing tabs on every context change — rejected: loses continuity and
  cannot avoid both failure modes.
- Persist contexts in host storage — rejected: transient presentation state would
  need schema plus stale-resource cleanup for no workflow gain.
