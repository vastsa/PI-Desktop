# ADR 0227: Project group manual ordering

- Status: Accepted (amended by 0228)
- Date: 2026-09-11
- Amends: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md)
- Related: [D399](../spec/08-meta/decisions-log.md) · [D402](../spec/08-meta/decisions-log.md) · [Component spec](../spec/04-ux/08-component-spec.md) · E2E-253

## Context

Retained project groups need a stable working order that is independent of
recent activity and alphabetical names. The existing sidebar organization is
renderer-owned presentation state, while project paths, selected workspace
identity, session ownership, and tool roots remain host-owned.

## Decision

Project groups expose a hover/focus-visible reorder grip. Native drag/drop and
ArrowUp/ArrowDown on the grip write contiguous non-negative integer `order`
values keyed by normalized project path and select the renderer-local `manual`
project sort. Reordering is allowed only within the same archived/pinned
priority bucket; those priority rules remain ahead of manual order.

The interaction is presentation-only. It does not move directories, change the
selected host workspace, change session ordering, or change durable session
project membership. Escape cancels a drag without consulting stale transfer
payload data. Invalid legacy ranks are ignored and fall back to stable path order.

## Consequences

- Users can keep repositories in a stable personal order across renderer restarts.
- Renderer localStorage remains the only persistence surface; no IPC, host RPC,
  schema, or migration is required.
- Priority boundaries make cross-bucket drops and keyboard moves no-ops instead
  of producing an order that the comparator immediately overrides.

## References

- `apps/desktop/src/components/Sidebar.tsx`
- `apps/desktop/src/lib/sidebar-preferences.ts`
- `apps/desktop/test/sidebar-preferences.test.mjs`
