# ADR 0047: Context usage inspector with exact and estimated token sources

- Status: Accepted
- Date: 2026-08-02
- Amended by: D225 (click-toggled panel), D244 (compact summary presentation),
  D347 (composer toolbar placement), and D355 (last-request occupancy)
- Related: [D103](../spec/08-meta/decisions-log.md) ·
  [D183](../spec/08-meta/decisions-log.md) ·
  [D184](../spec/08-meta/decisions-log.md) ·
  [IPC protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [Component spec](../spec/04-ux/08-component-spec.md)

## Context

The first context-usage ring exposed only a percentage and a small aggregate
breakdown. It did not answer why a turn became large, which tool contributed
the most context, or how quickly the model generated its output. The runtime
already has provider usage, tool arguments/results, and a model stream timing
anchor, but providers do not expose exact per-tool allocation.

## Decision

1. Replace the standalone ring with a compact Codex-style context inspector
   trigger. *(Amended by D225: hover and focus no longer open the panel;
   clicking or keyboard-activating the trigger toggles it.)* Activating the
   trigger reveals one scrollable, non-modal panel.
2. Keep provider-reported input/output/cache/reasoning usage authoritative and
   show aggregate output throughput as `outputTokens / responseDurationMs` on
   completed turns only; active streams do not render a live estimate.
3. Estimate each tool's argument and result footprint with the existing
   pi-agent-core token heuristic. Persist the estimate on the tool message,
   mark it as estimated in the UI, and never add it to the provider total.
4. Carry `responseDurationMs` on assistant messages and `toolUsage` on tool
   messages. Add `toolUsage` to `tool_end` as an optional event field so live,
   persisted, and restored transcripts use the same values.
5. Preserve additive compatibility: missing fields use the renderer fallback
   estimate or omit throughput when no stream duration is available.
6. Render the inspector panel through `document.body` as a fixed viewport
   overlay. Measure the trigger and panel rectangles, choose the side with
   available space, clamp the result to a viewport margin, and update the
   placement on transcript scroll, window resize, or panel-size changes. Keep
   the open/close and Escape dismissal behavior independent from the transcript
   scroll container.
7. Aggregate repeated tool rows by their exact tool name, preserving the
   first-seen order. Each row shows the number of calls and sums argument,
   result, token, and known duration estimates across those calls.
8. Resolve the context-window total from the same `pi-ai` model record that
   Electron passes to the agent sidecar, and enrich cached/discovered model
   rows with that value. Use provider metadata and the 128K default only when
   the selected model is absent from the `pi-ai` catalog.

## Consequences

- Users can inspect exact model usage and see each tool type's relative context
  footprint without opening logs, while repeated calls stay compact and
  auditable through their call counts.
- Historical tool rows remain useful through a deterministic fallback estimate.
- Tool estimates are transparent but cannot claim billing precision.
- The transcript protocol and storage shape gain optional fields, while the
  existing protocol version remains compatible.
- The panel is no longer constrained by the transcript's overflow clipping or
  stacking context; collision-aware placement keeps its complete contents
  visible at viewport edges.

## Alternatives

- Keep the ring-only UI: rejected because it hides the source of large turns.
- Claim exact per-tool provider usage: rejected because the provider response
  does not contain that attribution.
- Calculate throughput from wall-clock turn time: rejected because tool wait
  and provider wait would distort model generation speed.
