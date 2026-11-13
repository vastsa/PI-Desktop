# ADR sidebar-layout-recovery: Recover sidebar layout independently of Chromium storage

- Status: Accepted
- Date: 2026-11-07
- Amends: ADR 0016 and the renderer sidebar preference contract in data storage.

## Context

Sidebar presentation state previously existed only in renderer localStorage.
A fresh Chromium profile could therefore hide every retained Project except
the Host-selected one while the Project archive and Sessions remained intact.

## Decision

Keep an atomic, private `sidebar-preferences.json` copy in the selected app data
root. Only the trusted Main top frame can read or replace it through dedicated
IPC. Main owns this presentation backup, while Rust continues to own Projects,
Sessions and the active Workspace. The renderer cache remains a first-paint
optimization, not the sole durable copy.

Restore before bootstrap persists its selected Project. An existing backup wins
over the cache; without a backup, migrate a valid legacy cache, including an
explicitly empty retained-tab list. Only when both are absent or invalid may
the renderer recover registered Projects from the Host. An unreadable backup
must not be overwritten by an empty startup snapshot. Recovery never changes
the Host-selected Workspace and cannot recover lost pin/archive/name metadata
when neither copy exists.

## Consequences

Writes are bounded to 2 MiB, flushed and atomically renamed. Offline storage
relocation updates retained internal paths and Project metadata keys while
preserving external Projects and display labels. No schema version changes,
plugin API or remote control capability are added.
