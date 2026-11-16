# ADR 0047: Context usage inspector with exact and estimated token sources

- Status: Accepted (amended by D225, D244, D347, D355)
- Date: 2026-08-02
- Related: D103, D183, D184

## Context

The first context-usage ring showed a percentage and a small aggregate breakdown,
so it could not explain why a turn became large or which tool contributed most of
the context. Providers report usage but expose no exact per-tool allocation.

## Decision

1. A compact Codex-style inspector trigger replaces the standalone ring and
   toggles one scrollable, non-modal panel by click or keyboard activation (D225).
2. Provider-reported input, output, cache, and reasoning usage stays
   authoritative. Aggregate throughput is `outputTokens / responseDurationMs` on
   completed turns only, never a live estimate.
3. Each tool's argument and result footprint is estimated with the pi-agent-core
   token heuristic, persisted on the tool message, and marked as estimated; it is
   never added to the provider total.
4. Assistant messages carry `responseDurationMs` plus `providerWaitMs` and
   `modelStreamDurationMs`, tool messages carry `toolUsage` and `toolDurationMs`,
   and `tool_end` gains optional `toolUsage`, so live, persisted, and restored
   transcripts agree. The change is additively compatible: a missing field falls
   back to the renderer estimate or omits throughput.
5. Repeated tool rows aggregate by exact tool name in first-seen order, with call
   count and summed estimates.
6. The panel renders through `document.body` as a fixed overlay with
   collision-aware placement, and its dismissal is independent of the transcript
   scroll container.
7. The context-window total comes from the same `pi-ai` model record Electron
   passes to the sidecar, with a conservative default only when the model is
   absent from the catalog.

## Consequences

- Users see exact model usage and each tool type's footprint without opening logs,
  with repeated calls compact and auditable by count.
- Session timing separates provider wait from streamed generation and top-level
  tool execution; nested delegate timings are excluded.
- The protocol and storage shape gain optional fields while the version stays
  compatible.

## Alternatives

- Keep the ring-only UI: hides the source of large turns.
- Claim exact per-tool provider usage: providers carry no such attribution.
