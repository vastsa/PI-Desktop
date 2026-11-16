# ADR 0171: Host-owned completed-turn token history

- Status: Accepted (amended by ADR 0173)
- Date: 2026-09-07
- Related: D103, D157, D331, D335, ADR 0014, ADR 0173

## Context

The `turns` table already stores `input_tokens`, `output_tokens`, and `usage_json`,
and `session.endTurn` already accepted `usage`, but Electron never sent it, while
per-message chips read provider usage from assistant `meta_json`, where subagent
spend would inflate the context inspector. A durable completed-turn total is still
needed without a new schema version.

## Decision

1. **Parent `message.usage` stays provider-reported.** Subagent totals never merge
   into an assistant row.
2. **Turn rollup is `session.endTurn.usage`.** Electron sums every parent assistant
   `message_end` usage and adds `turn_end.subagentUsage` deltas.
3. **`stats.getTokenUsageHistory` is an additive host RPC** that reads completed
   turns in a bounded calendar window, buckets by `day` / ISO `week` / `month`, and
   bumps neither `PROTOCOL_VERSION` nor `SCHEMA_VERSION`.
4. **The dashboard is not Settings.** ADR 0173 moves that surface to plugin
   `pi.token-insights`, and rows written before Electron sent `usage` may be zero.

## Consequences

- Context inspector and chips keep exact provider values.
- New completed turns populate host history; older turns may be zero.
- A backfill from transcript `meta.usage` would be a separate change.

## Alternatives

- Rewrite parent `message.usage` with subagent spend — rejected: it corrupts the
  inspector and composed-turn total.
