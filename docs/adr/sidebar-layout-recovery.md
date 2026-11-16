# ADR sidebar-layout-recovery: Recover sidebar layout independently of Chromium storage

- Status: Accepted
- Date: 2026-11-07
- Related: ADR 0016

## Context

Sidebar presentation state lived only in renderer localStorage, so a fresh Chromium
profile could hide every retained project except the host-selected one.

## Decision

Main keeps an atomic, private `sidebar-preferences.json` copy in the selected app data
root that only the trusted Main top frame reads or replaces over dedicated IPC, while
Rust keeps owning projects, sessions, and the active workspace. Restore runs before
bootstrap persists its selected project: an existing backup wins over the cache, a valid
legacy cache is migrated otherwise, and only when both are absent or invalid may the
renderer recover projects from the host. An unreadable backup is never overwritten by an
empty startup snapshot.

## Consequences

- A wiped profile no longer loses the sidebar; only an absent and invalid pair falls back
  to host recovery.
- Writes stay atomic and bounded, with no schema or API change.
