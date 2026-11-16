# ADR 0252: Host turn-end event for plugins

- Status: Accepted
- Date: 2026-09-13
- Related: [D422](../spec/08-meta/decisions-log.md) ·
  [ADR 0005](0005-user-installable-plugin-system.md) ·
  [ADR 0040](0040-plugin-resident-services-and-message-bus.md) ·
  [ADR 0213](0213-persist-host-owned-turn-queue.md) ·
  [ADR 0235](0235-domain-facades-and-architecture-budgets.md) ·
  `07-plugins/03-plugin-api.md`

## Context

A plugin driving a notification surface, launcher, or work-panel view could
observe `workspace:changed`, `plugin:settingsChanged`, and
`session:modelChanged`, but nothing told it when the turn it reacted to had
finished, so plugins fell back to idle timers that fire during a long tool call
and again for a turn that already ended. The host already resolves the durable
`session.endTurn` row for the turn created by `session.beginTurn`; what was
missing was a published identity and boundary, since the plugin tool context
declared `turnId` but the host never populated it.

## Decision

1. **`session:turnEnded` is a host event.** Payload is
   `{ sessionId: string; turnId: string; reason: "completed" | "aborted" | "error" }`,
   delivered to plugin processes like `workspace:changed` and
   `session:modelChanged`, and also to plugin panel pages and docked views.
2. **Once per turn actually started.** It is emitted at turn teardown after the
   durable `session.endTurn` attempt and only for a turn created by
   `session.beginTurn`, so a queued item that never started produces no event
   and a second terminal event joins the first claim.
3. **Turn identity is authoritative.** The finalizer receives an explicit
   `turnId` and never infers one from the active turn, so a late terminal event
   from an earlier turn cannot settle a newer one; plugin tool contexts carry
   the same `turnId` unchanged.
4. **No new permission.** The event travels on the existing plugin event channel
   to every loaded plugin, and subscribing to an unknown event name does not
   error.

There is no ack and no replay: the host broadcasts once per started turn, so
delivery racing a plugin crash, reload, or host quit is not guaranteed, and
receiving the event does not mean every in-flight tool of that turn has exited.

## Consequences

- Plugins settle turn-scoped UI, notifications, and bookkeeping from the host's
  own terminal state instead of guessing with idle timers.
- The event bounds the turn, not individual tool calls, so late results stay
  valid and cleanup must be scoped by `turnId`.
- A plugin that depends on the event must require the first release that ships
  it, not 0.14.7 or 0.14.8.

## Alternatives rejected

- Poll a session API for the active turn: it needs `session.read`, exposes the
  conversation, and still leaves the end boundary to guesswork.
- Raise the idle timeout: it detects turn end later and still cannot tell a
  thinking tool from a finished turn.
