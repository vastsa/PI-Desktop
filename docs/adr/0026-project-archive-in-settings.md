# ADR 0026: Move the Projects Index into Settings as an Archive

- Status: Superseded in part by ADR 0036 (destination count/order)
- Date: 2026-07-27
- Related: [ADR 0013](0013-compact-settings-directory.md) ·
  [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md) (D066, D090,
  D093, D133)

## Context

The home sidebar exposed both a Projects destination and retained project
groups, duplicating the project concept and giving archival management the same
prominence as task creation. The frozen four-destination Settings directory
from ADR 0013 had no place for that management surface.

## Decision

Remove the standalone Projects destination from the sidebar, app page state, and
global page search, and add **Project archive** (`项目归档`) to Settings after
Import and before Info, making five destinations. The archive reuses the durable
Projects index with its search, add, activate, session expansion, pin,
archive/restore, and close actions, always includes archived rows, and does not
apply the sidebar's archived-session visibility filter to expanded details.
Activating a project or session returns to chat; archiving or closing keeps the
destination visible. The sidebar keeps retained project groups and the
persistent new-project action, and storage, renderer metadata, and the
one-visible-workspace activation model are unchanged.

## Consequences

- The sidebar has one fewer primary destination; historical projects stay
  recoverable through Settings, including imported paths.
- Settings grows from four to five destinations, superseding ADR 0013 only for
  destination count and ordering.
- No IPC, host RPC, database, security, or activation contract changes.

## Alternatives

- Projects in both the sidebar and Settings: rejected; duplicate navigation
  leaves ownership unclear.
- Show only archived rows: rejected; closed but unarchived projects would lose
  their only index-based recovery path.
