# ADR: Desktop-owned automation dispatch with Host-owned schedules

- Status: Accepted for implementation; amended by ADR 0305
- Date: 2026-09-20

## Context

The Scheduled page stored a cadence but never dispatched work when it became due.
The pinned pi packages supply agent execution, not a persistent desktop wall-clock
scheduler, and the host-owned task and run tables already provide the right storage
boundary.

## Decision

Schedule calculation, persistence, duplicate admission, and restart recovery stay in
Rust host-core. A small Electron lifecycle service polls while the app runs and
dispatches admitted work through the existing `agentPrompt` handler, never asking the
renderer to execute a background task, and the existing turn finalizer closes the
run. The existing `config_json` extension boundary carries a validated
`{hour, minute, weekday, weekdays?}` schedule, `nextRunAt` in epoch milliseconds,
and the `workspacePath` captured when the schedule is first configured, so no new
tables, columns, or migration are needed; old cadence-only records stay unarmed until
configured. `scheduled.run` keeps its prepare-only response, `scheduledExecute`
dispatches a turn, and `scheduledListRuns` exposes the run ledger. Automatic runs use
the task's saved permission mode, default to Ask when the field is absent, keep Plan
and Goal denied, and reuse a saved provider and model or resolve the app defaults at
execution time, while the task's project survives a foreground workspace change.
Scheduled is reachable from a footer clock action and global search.

### Calendar provenance

The optional `calendarConfigured` key records explicit Daily or Weekly intent
separately from Hourly's internal placeholder. Legacy Daily and Weekly rows infer
intent from their cadence, while legacy Hourly rows keep their fields but require an
explicit schedule on conversion, because their origin cannot be recovered.

### Conversation management

Project-scoped CRUD is exposed as on-demand Agent tools through the existing
`tools.execute` permission and audit pipeline. A thin host adapter reuses the
scheduled RPC handlers with the calling session's project, so a background
conversation cannot retarget tasks, and list stays read-only.

## Consequences

- The app must keep running: a due occurrence more than ninety seconds late is
  skipped rather than replayed in a burst, and an active run suppresses an
  overlapping occurrence.
- Daily and weekly times follow the host timezone and weekly schedules need a
  nonempty unique weekday selection, while hourly tasks wait one elapsed hour after
  saving, enabling, startup, or the previous admission.
- No cloud execution, OS service, arbitrary cron, or sub-hourly interval is added.

## Alternatives

- A plugin: duplicates lifecycle and storage ownership.
- A second agent loop: bypasses existing admission, persistence, and permissions.
