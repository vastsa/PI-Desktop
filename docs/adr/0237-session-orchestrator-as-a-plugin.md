# ADR 0237: Keep Session Orchestration in an Official Plugin

- Status: Accepted
- Date: 2026-09-13
- Updated: 2026-09-13
- Decision: D391
- Related: ADR 0200, ADR 0203, ADR 0208, ADR 0062, ADR 0089

## Context

Some tasks benefit from several independent Agents working at the same time,
but the existing `Task` family is intentionally a bounded in-process
subagent system. A new orchestration feature must not create a second session
store, bypass plugin permissions, or make the renderer an Agent runtime.

The public plugin SDK already exposes Agent tools and the reviewed
`desktop.control` gateway. It does not expose live session creation or Agent
lifecycle events, so the first implementation needs a small composition layer
without moving orchestration into host-core.

## Decision

Ship `pi.session-orchestrator` as an ordinary marketplace plugin. It registers the
`SessionTask` Agent Tool with `spawn`, `send`, `supervise`, `status`, `wait`,
`result`, `accept`, `cancel`, and `list` actions.

- `spawn` uses `session/create` followed by `agent/prompt`, creating a new
  durable session with no copied transcript. It inherits the parent project,
  provider/model, thinking level, and permission mode.
- `send` reuses the recorded worker session. `cancel` uses `agent/abort` and
  never deletes the session.
- The plugin persists only the parent/worker relationship, task, status,
  timestamp, and bounded report in its private data directory. The host-owned
  worker transcript remains the source of truth. The canonical worker identity
  in the tool response and relationship store is the original durable
  `sessionId` returned by `session/create`; 0.2.x `workerSessionId` settings are
  migrated on load and no second Work ID is created.
- A parent may control only Worker Session IDs recorded under its own session
  id. A `send` or `supervise` follow-up addresses those same Session IDs, so a
  child retains its own context without creating a replacement session. Worker
  sessions cannot use the tool to create or control more workers. Active work
  is capped at four workers per parent and sixteen across the plugin.
- Until a lifecycle subscription exists, `wait` performs one-second lightweight
  status polling with a 25-second default and 45-second maximum timeout. Each
  desktop read is bounded at five seconds, report transcript reads are deferred
  until a worker is no longer running, and a timeout returns `timedOut` so the
  plugin tool does not occupy the host deadline indefinitely. The Agents panel
  uses the same status-only refresh path.
- A simple `Agents` work-panel view lists workers and offers status refresh,
  Open Session, and Stop.

Two additive host primitives support these boundaries:

1. `session/create` accepts optional `inheritPermissionFromSessionId`. For a
   plugin-originated call, the desktop gateway binds that id to the current
   Agent tool session. The host then copies the existing parent's persisted
   permission mode while holding the state lock; callers never submit an
   arbitrary worker permission mode, and omission retains the existing
   `inherit` default.
2. The reviewed desktop catalog gains `session/open`, which validates and
   selects an existing durable session. Plugin-originated create/prompt calls
   refresh the renderer without stealing the parent's active session; explicit
   `session/open` is the only navigation action.

No Rust schema migration, MCP self-call, MCP token access, A2A channel, message
bus, DAG, or change to `Task`, `TaskWait`, `TaskList`, or `TaskStop` is added.

## Consequences

The parent can fan out real durable workers while every worker stays visible
and inspectable in the normal session UI. Existing session and subagent
behavior remains intact, and plugin data can restore the relationship list
after a plugin or app restart.

The first version does not receive lifecycle events and therefore has bounded
polling latency. The plugin also has a four-worker limit and does not provide
unscoped arbitrary-session control or worker-to-worker messaging. A dangerous
host operation is never used for orchestration; any future extension must
preserve the existing desktop-control permission and native-consent boundary.

## Verification

The plugin runtime integration test covers three parallel real-session
requests, parent scoping, persistence across reload, canonical Session ID
routing, same-session context reuse, bounded report extraction, timeout-safe
status polling, legacy settings migration, and cancellation without deletion.
Host-core tests cover the optional permission-inheritance input. The E2E plan records
the live-provider journey as `E2E-PLUGIN-session-orchestrator-real-workers`.
