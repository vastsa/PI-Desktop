# ADR 0237: Keep Session Orchestration in an Official Plugin

- Status: Accepted
- Date: 2026-09-13
- Updated: 2026-09-13
- Decision: D391
- Related: ADR 0200, ADR 0203, ADR 0208, ADR 0062, ADR 0089

## Context

Some tasks benefit from several independent Agents working at once, but the
`Task` family is intentionally a bounded in-process subagent system. A new
orchestration feature must not create a second session store, bypass plugin
permissions, or make the renderer an Agent runtime, and the public plugin SDK
exposes Agent tools and the reviewed `desktop.control` gateway but no live
session creation or Agent lifecycle events.

## Decision

Ship `pi.session-orchestrator` as an ordinary marketplace plugin registering the
`SessionTask` Agent Tool with `spawn`, `send`, `supervise`, `status`, `wait`,
`result`, `accept`, `cancel`, and `list`. `spawn` calls `session/create` then
`agent/prompt` to create a new durable session with no copied transcript,
inheriting the parent project, provider/model, thinking level, and permission
mode; `send` reuses the recorded worker session and `cancel` uses `agent/abort`
without deleting it. The plugin persists only the parent/worker relationship,
task, status, timestamps, and a bounded report in its private data directory,
while the canonical worker identity is the durable `sessionId` returned by
`session/create`. A parent may control only worker sessions recorded under its
own session id, workers cannot create or control further workers, and the
concurrency ceiling is the plugin's own `maxConcurrentSessions` setting. Until
lifecycle subscription exists, `wait` polls status with bounded timeouts and
returns `timedOut`, and an `Agents` work-panel view lists workers with refresh,
Open Session, and Stop. Two additive host primitives support this:
`session/create` accepts `inheritPermissionFromSessionId`, bound to the current
Agent tool session for plugin callers and copying the parent's persisted
permission mode, and the reviewed desktop catalog gains `session/open`, the only
action that navigates the renderer. No schema migration, MCP self-call, message
bus, DAG, or change to the `Task` tools is added.

## Consequences

- The parent fans out real durable workers that stay visible and inspectable in
  the normal session UI, and plugin data restores the relationship list after a
  restart.
- The first version has bounded polling latency, no worker-to-worker messaging,
  and no unscoped arbitrary-session control.
- A delivery interrupted by restart cannot settle, so `recover` emits one
  receipt with `status: "interrupted"` and the fence's error text instead of
  leaving the sender polling forever.
