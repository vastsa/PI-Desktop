# ADR: Desktop-owned automation dispatch with Host-owned schedules

- Status: Accepted for implementation; amended by ADR 0305
- Date: 2026-09-20

## Context

The shipped Scheduled page stores a cadence but never dispatches work when that
cadence becomes due. The pinned pi-ai, pi-agent-core and pi-coding-agent 0.87.1
packages supply agent execution, not a persistent desktop wall-clock scheduler.

## Decision

Keep schedule calculation, persistence, duplicate admission and restart recovery
in Rust host-core. A small Electron lifecycle service polls every 30 seconds
while the app runs and dispatches admitted work through the existing agentPrompt
handler.

Use the existing config_json extension boundary for a validated schedule {hour,
minute, weekday, weekdays?}, nextRunAt in epoch milliseconds and workspacePath.
The workspace is captured when a schedule is first configured.

## Consequences

The app must remain running.

## Calendar provenance compatibility

The optional `calendarConfigured` configuration key records explicit Daily or
Weekly calendar intent separately from Hourly's required internal placeholder.
Legacy Daily/Weekly rows infer intent from their saved cadence.

## Alternatives

A plugin would duplicate lifecycle/storage ownership and make baseline
automation depend on extension availability.

## Conversation management

Expose project-scoped CRUD as on-demand Agent tools using the existing
`tools.execute` permission and audit pipeline. A thin Host adapter reuses the
scheduled RPC handlers with the calling session's project, so background
conversations cannot retarget tasks when the foreground workspace changes.

The UI offers four time periods (09:00, 14:00, 19:00, 22:00) to keep setup
simple. AI tools retain precise local time configuration, and the form preserves
those custom times.
