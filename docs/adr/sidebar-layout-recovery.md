# ADR sidebar-layout-recovery: Recover sidebar layout independently of Chromium storage

- Status: Accepted
- Date: 2026-11-07
- Amends: ADR 0016 and the renderer sidebar preference contract in data storage.

## Context

Sidebar presentation state previously existed only in renderer localStorage. A
fresh Chromium profile could therefore hide every retained Project except the
Host-selected one while the Project archive and Sessions remained intact.

## Decision

Keep an atomic, private `sidebar-preferences.json` copy in the selected app data
root. Only the trusted Main top frame can read or replace it through dedicated
IPC.

Restore before bootstrap persists its selected Project. An existing backup wins
over the cache; without a backup, migrate a valid legacy cache, including an
explicitly empty retained-tab list.

## Consequences

Writes are bounded to 2 MiB, flushed and atomically renamed.
