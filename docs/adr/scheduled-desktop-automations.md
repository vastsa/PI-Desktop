# ADR: Desktop-owned automation dispatch with Host-owned schedules

- Status: Accepted for implementation
- Date: 2026-09-20

## Context

The shipped Scheduled page stores a cadence but never dispatches work when
that cadence becomes due. The pinned pi-ai, pi-agent-core and pi-coding-agent
0.85.1 packages supply agent execution, not a persistent desktop wall-clock
scheduler. The existing Host-owned task and run tables already provide the
appropriate storage boundary.

## Decision

Keep schedule calculation, persistence, duplicate admission and restart recovery
in Rust host-core. A small Electron lifecycle service polls every 30 seconds
while the app runs and dispatches admitted work through the existing agentPrompt
handler. It never asks the renderer to execute a background task. The existing
turn finalizer closes the task run. The service stops when the app quits.

Use the existing config_json extension boundary for a validated schedule
{hour, minute, weekday, weekdays?}, nextRunAt in epoch milliseconds and workspacePath.
The workspace is captured when a schedule is first configured. No new tables,
columns, schema migration or change to existing task identifiers is needed.
Old cadence-only records remain unarmed until explicitly configured. Existing
scheduled.run retains its prepare-only response; additive scheduledExecute IPC
dispatches a turn, and scheduledListRuns exposes the existing run ledger.

Automatic runs use Ask permission mode. They may wait for a user in their result
conversation; this feature never grants approval. Plan/Goal rejection remains.
The default provider/model are resolved at execution time. Retain the task's
project even when the foreground workspace changes.

Expose Scheduled through a footer clock action as well as global search.
The page has task and run-history views, editing, pause/resume, Run now and
conversation links. This amends the earlier omission of Scheduled from the
home sidebar; other destinations and navigation ownership remain unchanged.

## Consequences

The app must remain running. A due occurrence more than 90 seconds late is
skipped, never replayed in a burst. An active run suppresses an overlapping
occurrence. Startup interrupts orphaned runs and arms only future occurrences.
Daily/weekly times follow the host's local timezone. Weekly schedules accept
a nonempty unique selection of weekdays, falling back to the legacy single
weekday when absent. Hourly tasks instead wait one elapsed hour after saving,
enabling, startup or the preceding admission. This avoids a minute selector
for a fixed interval while preserving calendar semantics for daily/weekly tasks.
No cloud execution, OS service, arbitrary cron or sub-hourly interval is added.
Downgrading keeps the existing records readable but removes automatic execution.

## Alternatives

A plugin would duplicate lifecycle/storage ownership and make baseline
automation depend on extension availability. A second agent loop would bypass
existing admission, persistence and permissions. Both are rejected. The pi
agent implementation remains the execution engine.

## Conversation management

Expose project-scoped CRUD as on-demand Agent tools using the existing
`tools.execute` permission and audit pipeline. A thin Host adapter reuses the
scheduled RPC handlers with the calling session's project, so background
conversations cannot retarget tasks when the foreground workspace changes.
List is read-only; mutations keep normal approvals. Plan/Goal stay denied.

The UI offers four time periods (09:00, 14:00, 19:00, 22:00) to keep setup
simple. AI tools retain precise local time configuration, and the form preserves
those custom times. Direct database access or renderer-mediated tool mutation
would duplicate ownership or bypass permission gates and is rejected.
