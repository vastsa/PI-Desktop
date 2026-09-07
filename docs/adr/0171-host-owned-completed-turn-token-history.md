# ADR 0171: Host-owned completed-turn token history

- Status: Accepted
- Date: 2026-09-07
- Deciders: PI-Desktop core
- Related: D103, D157, D331, ADR 0014,
  `03-runtime/04-data-storage.md` §4.6,
  `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/06-settings-ia.md`, E2E-186

## Context

The `turns` table already stores `input_tokens`, `output_tokens`, and
`usage_json`, and `session.endTurn` already accepted `usage`. Electron never
sent it. Per-message chips (D103) read provider usage from assistant
`meta_json`. Mixing subagent spend into those chips would inflate the context
inspector and the composed-turn total.

A Settings destination still needs a global history of what the user actually
spent, including subagents, without a new schema version.

## Decision

1. **Parent `message.usage` stays provider-reported.** Subagent totals never
   merge into an assistant row.
2. **Turn rollup is `session.endTurn.usage`.** Electron sums every parent
   assistant `message_end` usage for the durable turn and adds
   `turn_end.subagentUsage` deltas. Only that sum is stored on `turns`.
3. **`stats.getTokenUsageHistory` is an additive host RPC.** It reads completed
   turns in a bounded local-calendar window, buckets by `day` / ISO `week` /
   `month`, fills empty buckets, and does not bump `PROTOCOL_VERSION` or
   `SCHEMA_VERSION`. `idx_turns_ended_at` is created with
   `CREATE INDEX IF NOT EXISTS` at boot.
4. **Settings → Usage** is a Preferences destination. It shows totals and an
   activity matrix. It does not price tokens. Historical rows from before
   Electron sent `usage` may be zero.

## Consequences

- Context inspector and D103 chips keep exact provider values.
- New completed turns populate the heatmap; older turns may not.
- A later backfill from transcript `meta.usage` would be a separate change.

## Alternatives

- Rewrite parent `message.usage` with subagent spend: rejected (D103).
- Scan JSONL transcripts on each Settings open: rejected (unbounded, wrong
  owner).
