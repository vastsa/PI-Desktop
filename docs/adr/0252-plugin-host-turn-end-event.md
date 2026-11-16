# ADR 0252: Host turn-end event for plugins

- Status: Accepted
- Date: 2026-09-13
- Deciders: PI-Desktop core
- Related: [D422](../spec/08-meta/decisions-log.md) · [ADR 0005](0005-user-installable-plugin-system.md) · [ADR 0040](0040-plugin-resident-services-and-message-bus.md) · [ADR 0213](0213-persist-host-owned-turn-queue.md) · [ADR 0235](0235-domain-facades-and-architecture-budgets.md) · `07-plugins/03-plugin-api.md` · `07-plugins/13-plugin-permissions-matrix.md`

## Context

A plugin that drives a GUI — a notification surface, a launcher, a work-panel
view — can already observe `workspace:changed`, `plugin:settingsChanged`, and
`session:modelChanged`, but nothing told it when the host turn it was reacting
to had actually finished. Plugins fell back to idle timers, which are wrong in
both directions: they fire during a long tool call, and they fire again for a
turn that ended moments earlier.

## Decision

1. **`session:turnEnded` is a host event.** Payload is `{ sessionId: string;
   turnId: string; reason: "completed" | "aborted" | "error" }`, delivered to
   plugin processes exactly like `workspace:changed` and `session:modelChanged`,
   and (like `workspace:changed`) to plugin panel pages and docked views.

2. **Once per turn actually started.** The event is emitted at the end of turn
   teardown, after the durable `session.endTurn` attempt, and only for a turn
   created by `session.beginTurn`: a user submission, an approved plan
   execution, or a scheduled run.

3. **Turn identity is authoritative.** The finalizer is called with an explicit
   `turnId` and never infers one from whichever turn happens to be active, so a
   late terminal event from an earlier turn cannot settle a newer one, and a
   terminal event carrying no identity settles nothing at all.

4. **No new permission.** The event travels on the existing plugin event channel
   to every loaded plugin, and subscribing to an unknown event name does not
   error.

Explicit non-promises: there is no ack and no replay. The host broadcasts once
per started turn; a plugin that is alive and subscribed receives it once.

## Consequences

- Plugins settle turn-scoped UI, notifications, and bookkeeping from the host's
  own terminal state instead of guessing with idle timers.
- The event bounds the turn, not the individual tool calls, so a plugin must
  still treat late tool results as valid.
- The announcement is one call made from one finalizer that validates turn
  identity, requires no `await` before it claims the turn, and runs after the
  local teardown.
- Turn-scoped cleanup that ignores `turnId` can settle the wrong turn; the tool
  context's `turnId` now makes correct scoping possible.
- No published release emits this event yet: the first release that contains it
  has not shipped, and 0.14.8 does not include it.

## Alternatives rejected

### Poll a session API for the active turn

Reading session state on a timer would need `session.read`, would hand a plugin
the conversation it does not otherwise see, and would still leave the end
boundary to guesswork — the event carries no more than the identity and reason
the host already owns.

### Release the plugin per invocation

Unloading a plugin when its turn ends ties turn end to a lifecycle event that
also has to survive reload, crash, and quit, and would drop the resident
services and panel state a plugin holds across turns.

### Raise the idle timeout

A longer silence threshold detects turn end later and still cannot distinguish
"a tool is thinking" from "the turn is over"; it also delays exactly the
completion signal a GUI plugin exists to deliver.

## References

- `apps/desktop/electron/main/runtime/plans.ts` — `finishTurn`, the single
  teardown entry every terminal path funnels through
- `apps/desktop/electron/main/runtime/session-coordination.ts` — turn identity,
  the abort lock, and the shared busy check
- `apps/desktop/electron/main/services/plugin-services.ts` — `announceTurnEnded`
- `apps/desktop/electron/main/plugin-runtime.ts` — `broadcastEvent`
