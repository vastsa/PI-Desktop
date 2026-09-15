# ADR 0258: Live turn throughput is a renderer-side windowed estimate

- Status: Accepted
- Date: 2026-09-15
- Deciders: PI-Desktop desktop UI maintainers
- Amends: 0073
- Related: ADR 0047 · ADR 0242 (D412) ·
  [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [04-ux/09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-CHAT-live-generation-throughput · issue #93 (duplicate #394)

## Context

Generation speed exists only after a turn settles. ADR 0073 made the stopped
case durable by preserving `responseDurationMs` and an optional
`responseOutputTokens` estimate, and the composer inspector divides one by the
other. While a turn runs there is no readout at all, so a user cannot tell a
model that is streaming slowly from one that has stalled, or from a long tool
call during which the model is not running.

The runtime offers no incremental token source. Provider usage is read exactly
once, at `message_end`; the `message_update` event carries text and thinking
deltas only. Any figure shown during the turn is therefore an estimate, not a
measurement.

A previous attempt shipped and was reverted the same day (`d3beca92`,
`2c8ad1ff`, 2026-08-02). It stamped `responseDurationMs` onto every streaming
`message_update` inside the runtime and displayed a cumulative average taken
from the start of the stream. That predates ADR 0242, which replaced broadcast
message snapshots with coalesced deltas and established that per-token data
must not reach store subscribers.

## Decision

1. The live figure is computed in the renderer. No runtime, protocol, IPC,
   storage, or store-schema change: `PROTOCOL_VERSION` stays at 11.
2. Estimated output tokens reuse ADR 0073 §3 — visible thinking plus answer
   text at four Unicode code points per token — through the same
   `estimateResponseOutputTokens` helper the stopped path uses. Sampling is
   throttled rather than run per delta, because the estimate walks the message.
3. The rate is measured across a recent window from its endpoints, not
   cumulatively from the start of the stream. A cumulative average folds
   tool-execution wall clock into the denominator, so it decays after every
   long tool call and misreports a model that was never running.
4. Silence is reported as staleness, not as zero. Once no tokens have arrived
   for the stale interval the last measured rate is retained and dimmed. A rate
   appears only after the samples span a minimum interval.
5. The figure always uses the estimated copy (`chat.usageThroughputEstimated`),
   honouring ADR 0073 §4: exact provider usage wins, and an estimate is
   labelled as one. When the turn settles the meta row shows the completed-turn
   values and the live chip is gone.
6. It renders in the transcript meta row of the active turn, and is mounted
   only for that turn. The composer inspector stays a completed-turn surface.
   The sample window lives in that component's ref.

## Consequences

- A glanceable speed readout during thinking, streaming, and the generation
  around tool calls, without waiting for the turn to end.
- The number is approximate and labelled as such. It tracks the recent window,
  so it reacts to a slowdown instead of averaging it away.
- ADR 0242's boundaries hold: because the window is a ref inside the active
  turn and no store state is added, token growth cannot re-render the sidebar,
  and mounting only for the active turn keeps the sampler and its interval off
  history rows.
- Mount and unmount coincide with turn start and end, so the window needs no
  explicit lifecycle and cannot leak across turns or sessions.
- No new i18n keys, so all eight shipped catalogs stay in parity.
- Native rendering of the chip is a visual behaviour that unit tests cannot
  prove; E2E-CHAT-live-generation-throughput owns that acceptance.

## Rejected alternatives

### Stamp streaming duration in the runtime (the reverted approach)

Rejected. It couples a presentation concern to the agent runtime and writes
per-delta metadata that every peer must carry, and its cumulative average is
the behaviour this ADR exists to avoid. ADR 0242's delta pipeline makes the
renderer-side estimate feasible without touching the runtime at all.

### Keep one live rate in the store

Rejected. A sample per coalesced flush would notify every store subscriber,
which is precisely the re-render ADR 0242 removed. A ref confines the churn to
the component that displays it.

### Cumulative average from stream start

Rejected. It is stable but answers the wrong question: it cannot distinguish a
model that slowed down from a turn that spent a minute inside `Bash`.

### Blank the chip during tool execution

Rejected. A chip that disappears and returns changes the row height and moves
the content the user is reading, which is the class of jitter issue #323 tracks.
Dimming keeps the layout stable and still signals that nothing is generating.
