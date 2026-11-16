# ADR 0028: Scope work-panel runtime contexts to conversations

- Status: Accepted
- Date: 2026-07-27
- Amended in part by: [ADR 0108](0108-remove-built-in-interactive-terminal.md)

## Context

The renderer previously owned one global work-panel tab set. Selecting another
conversation or workspace closed the panel and destroyed every tab, as required
by D128.

## Decision

Each conversation owns a renderer-memory work-panel context containing its open
state, ordered tabs, active tab, file request, and Browser resource.

- Selecting a conversation saves the current projection and atomically restores
  the destination context.
- New and forked conversations begin with an empty context.
- Review and BrowserPreview artifacts are recorded against their originating
  `sessionId`, including while that conversation is in the background.
- Background artifacts update retained state only.
- BrowserPreview events carry `sessionId`.
- Selecting a workspace without an active conversation hides the current panel
  projection while retaining the prior conversation's state.
- Work-panel contexts remain transient.

This adopts D142 and supersedes only D128's requirement to close and clear tabs
on visible session/workspace changes. D128's artifact triggers, deduplication,
and close/collapse rules remain unchanged; its no-launcher rule is amended by
ADR 0068.

## Consequences

- Returning to a conversation restores its tools without reinterpreting paths
  against another workspace.
- Permission completion and asynchronous navigation no longer produce a
  transient panel open/close cycle or lose the resulting artifact.
- The renderer retains bounded per-session UI state until deletion or relaunch;
  it does not add durable storage or schema migration.
- The embedded browser remains one hardened Main-process WebContentsView.
- The former interactive terminal process/cache is no longer part of the
  work-panel runtime; Browser remains the Main-owned native resource.

## Alternatives

### Keep clearing tabs on every context change

Rejected because it loses task continuity and cannot avoid both permission
completion flashes and dropped background artifacts.

### Persist panel contexts in host storage

Rejected because tabs and Browser resources are transient presentation state.

### Key every backend panel subsystem by conversation

Rejected for this change.

## References

- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/03-permission-ux.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D142)
