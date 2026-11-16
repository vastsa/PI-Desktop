# ADR 0171: Host-owned completed-turn token history

- Status: Accepted (amended by ADR 0173)
- Date: 2026-09-07
- Deciders: PI-Desktop core
- Related: D103, D157, D331, D335, ADR 0014, ADR 0173,
  `03-runtime/04-data-storage.md` §4.6,
  `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/06-settings-ia.md`, E2E-186

## Context

The `turns` table already stores `input_tokens`, `output_tokens`, and
`usage_json`, and `session.endTurn` already accepted `usage`. Electron never
sent it.

## Decision

1. **Parent `message.usage` stays provider-reported.** Subagent totals never
   merge into an assistant row.
2. **Turn rollup is `session.endTurn.usage`.** Electron sums every parent
   assistant `message_end` usage for the durable turn and adds
   `turn_end.subagentUsage` deltas.
3. **`stats.getTokenUsageHistory` is an additive host RPC.** It reads completed
   turns in a bounded local-calendar window, buckets by `day` / ISO `week` /
   `month`, fills empty buckets, and does not bump `PROTOCOL_VERSION` or
   `SCHEMA_VERSION`.
4. **The user-facing dashboard is not Settings.** ADR 0173 moves that surface to
   marketplace plugin `pi.token-insights`.

## Consequences

- Context inspector and D103 chips keep exact provider values.
- New completed turns populate host history; older turns may be zero.
- The heatmap lives in `pi.token-insights` (ADR 0173).
- A later backfill from transcript `meta.usage` would be a separate change.

## Alternatives

- Rewrite parent `message.usage` with subagent spend: rejected (D103).
- Scan JSONL transcripts in the host Settings page: rejected (unbounded, wrong
  owner).
