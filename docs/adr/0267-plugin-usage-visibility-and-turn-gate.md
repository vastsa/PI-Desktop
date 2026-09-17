# ADR 0267: Plugin usage visibility and the extension turn gate

- Status: Accepted for implementation
- Date: 2026-09-16
- Deciders: PI-Desktop core
- Related: [D433](../spec/08-meta/decisions-log.md) · [ADR 0252](0252-plugin-host-turn-end-event.md) · [ADR 0005](0005-user-installable-plugin-system.md) · issue #399 · `07-plugins/03-plugin-api.md` · `07-plugins/13-plugin-permissions-matrix.md` · `07-plugins/16-trusted-extensions.md`

## Context

Issue #399 asks for usage visibility and for a conversation to stop once a
spending limit is reached. The maintainer direction is that this behaviour
belongs to plugins, but the plugin surface could not support it: a sandboxed
plugin saw no token usage anywhere — the `session.*` API carries no usage
fields and the `session:turnEnded` event (ADR 0252) carried only
`{ sessionId, turnId, reason }` — and nothing let a plugin or extension refuse
a turn. The closest existing hook, blocking every `tool_call`, stalls the
agent mid-turn instead of refusing the turn and leaves a half-finished reply.

The host already owns every ingredient. Each completed turn's usage is
persisted on `turns.usage_json`, `stats.getTokenUsageHistory` already rolls it
into day/week/month buckets, and the trusted-extension runner already folds
handler results for `before_agent_start`, the last hook before a turn's first
provider request.

## Decision

1. **`session:turnEnded` carries the turn's usage.** The payload gains an
   optional `usage: MessageUsage`, the same aggregated record the durable
   `session.endTurn` persisted, present only when the turn recorded usage. No
   new permission: the event already travels on the plugin event channel, and
   the field is additive (amends ADR 0252's payload shape only).

2. **`session.usage.read` exposes aggregate history.** A new low-risk
   permission gates `pi.session.getUsageHistory`, which reads the existing
   `stats.getTokenUsageHistory` host RPC. The data is host-wide aggregate
   counts — no message content, no session identity — so it does not ride on
   the high-risk `session.read`.

3. **`before_agent_start` may refuse the turn.** A trusted extension's
   `before_agent_start` result gains `{ block: true, reason?: string }`. A
   blocked turn ends before the first provider request with the
   `TURN_BLOCKED` error code and the extension's reason as the message; the
   durable turn row closes as `error`, exactly like the existing
   pre-flight failures (`CONTEXT_TOO_LARGE`). A block decision is sticky:
   later handlers in the fold may still replace the system prompt but cannot
   unblock. The system-prompt replacement contract is unchanged.

Explicit non-promises: the host keeps no budget, no prices, and no spending
policy. Accumulating usage, choosing limits, and presenting dashboards are all
plugin territory (D335). The gate refuses new turns only; it never aborts a
turn already running.

## Consequences

- A plugin can now implement #399 end to end: settle per-turn cost from the
  `session:turnEnded` payload, backfill history through
  `session.getUsageHistory`, and refuse over-budget turns from a
  `before_agent_start` handler.
- The gate sits before the first provider request, so a refused turn spends
  no tokens and leaves no partial reply.
- `TURN_BLOCKED` has no renderer copy of its own; the chat surface shows the
  extension's reason, which is the message a budget plugin wants the user to
  read.
- Sandbox plugins still cannot veto turns — the block hook lives in trusted
  extensions, which already run with agent-level trust (`agent.extension`).

## Alternatives rejected

### A host-owned budget ledger

Putting budgets and prices in host-core (usage × models.dev cost with a
configurable hard limit) works, but it hard-codes one spending policy into the
host and conflicts with the documented split that global usage dashboards
belong to plugins (D335). The three enablements above let any policy exist
without the host taking a side.

### Blocking via `tool_call`

An extension can already block individual tool calls, and using that as a
budget gate needs no new contract. But the turn has already started and may
already have streamed text, so the user pays for a partial reply and the agent
stalls instead of refusing cleanly.

### Wrapping providers in a plugin

`contributes.providers` is declarative: the plugin supplies an endpoint and a
model list, the key stays in the host, and request traffic never passes
through the plugin. There is no interception point to meter or refuse, and
creating one would put plugin code on the hot path of every model request.

## References

- `apps/desktop/electron/main/runtime/plans.ts` — `finishTurn`, where the
  settled usage joins the `session:turnEnded` announcement
- `apps/desktop/electron/main/plugin-runtime.ts` — the
  `session.getUsageHistory` host API and its permission gate
- `apps/desktop/electron/main/services/plugin-services.ts` — the wiring to
  `stats.getTokenUsageHistory`
- `packages/agent-runtime/src/runtime.ts` — `extensionBeforeAgentStart`, the
  turn gate
