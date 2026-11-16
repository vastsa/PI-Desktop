# ADR 0227: Project group manual ordering

- Status: Accepted (amended by 0228)
- Date: 2026-09-11
- Amends: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md)
- Related: [D399](../spec/08-meta/decisions-log.md) · [D402](../spec/08-meta/decisions-log.md) · E2E-253

## Context

Retained project groups need a stable working order independent of recent activity
and alphabetical names, while project paths, workspace identity, session ownership,
and tool roots stay host-owned.

## Decision

Groups expose a hover/focus-visible reorder grip; native drag and ArrowUp/ArrowDown
on the grip write contiguous non-negative integer `order` values keyed by
normalized project path and select the renderer-local `manual` sort. Reordering
stays inside one archived/pinned priority bucket, which ranks ahead of manual order;
Escape cancels without reading stale transfer data and invalid legacy ranks fall
back to stable path order. Nothing moves directories, the selected host workspace,
session ordering, or durable project membership.

## Consequences

- Users keep repositories in a stable personal order across renderer restarts.
- Renderer localStorage stays the only persistence surface; no IPC, host RPC,
  schema, or migration is involved.
- Cross-bucket drops are no-ops instead of an order the comparator overrides.
