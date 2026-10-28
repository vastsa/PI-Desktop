# ADR context-usage-insights-dashboard: Context insights dashboard inside the Composer panel

- Status: Accepted for implementation
- Date: 2026-10-28
- Recorded as: D675
- Amends: ADR 0047 (compact summary presentation, D244), ADR 0193 (last-request
  occupancy)
- Preserves: D225 click-toggled panel, D347 composer toolbar placement, D357
  conversation-pane clamp, and the existing session-timing ownership
- Related: [D103](../spec/08-meta/decisions-log.md) ·
  [Component spec](../spec/04-ux/08-component-spec.md) ·
  [Interaction patterns](../spec/04-ux/09-interaction-patterns.md) ·
  [E2E-060d](../spec/06-delivery/04-e2e-test-plan.md) ·
  [Issue #1940](https://github.com/vastsa/PI-Desktop/issues/1940)

## Context

The Composer's context panel answers "how full is the window" and "where did
the last turn's time go". It cannot answer why a window filled up, how one
request differed from the one before it, or what the model is still carrying
from earlier instructions. Answering those needs comparisons and drill-downs,
and ADR 0047's compact-only presentation (D244) rules them out by
construction.

Everything needed is already local: `UiMessage` carries provider `usage`,
`providerWaitMs`, `modelStreamDurationMs`, `thinking`, `toolUsage`, and the
chronological `modelSystem` records; `ContextCompactionMark` carries each
checkpoint; `lib/context-usage.ts` already owns the token estimate and
occupancy helpers. A transcript is still not the assembled provider request:
old instructions, removed tool declarations, and compacted messages remain in
the file and must never be presented as live occupancy.

## Decision

1. Keep the Composer trigger, its used/remaining preference and capacity
   colours, the body portal, the conversation-pane clamp, and the toolbar
   placement from ADR 0047 and D347. Replace the compact summary inside the
   popover with a responsive, scrollable card dashboard.
2. Project the loaded parent transcript once in `lib/context-insights.ts`:
   request order (turn/step), anchored system records in transcript order,
   six recorded-history categories, provider token segments, and trend points.
   Nested delegates and duplicate system records are excluded.
3. The default view is the latest request. Selecting another request changes
   only the token card and the recorded-history browser; the capacity card
   always shows the newest parent request (ADR 0193).
4. Treat provider input/cache/output as exact metadata and reasoning as a
   subset of output. Turn granularity selects the last request in a turn, never
   a billing rollup. Negative deltas stay visible.
5. Ask the browser for the six recorded sources and label its contents as
   estimated history recorded before the selected request. Do not infer an
   assembled prompt, a compaction reserve, tokenizer accuracy, missing system
   text, costs, or cross-session statistics.
6. Reuse the existing bounded session-timing reads and their loading/error
   states. The timing donut sums measured activity; session wall time and the
   row percentages keep their current meaning, and unknown values stay unknown.
7. Use semantic design tokens for every series colour, add only the two chart
   hues the four semantic colours cannot express, and ship English plus every
   existing locale.
8. A session switch dismisses the panel; opening moves focus to the close
   button and Escape restores the Composer trigger.

## Consequences

- The Composer now offers the comparisons and drill-downs the reference
  dashboard provides, and ADR 0047's compact-only restriction no longer
  applies to the panel's body.
- Historical requests only describe what the transcript still records; deleted
  or unloaded pages leave gaps that the UI labels rather than fills.
- Full provider-request reconstruction, file-operation inference, agent-fleet
  accounting, and global billing stay outside this renderer change.
- No new IPC, Host API, runtime accounting, storage schema, external
  transmission, or credential access is introduced.

## Alternatives

- **Keep the compact summary and add one chart.** Rejected: the trend and the
  browser only pay off together, because the selection is what connects a bar
  to the records behind it.
- **Reconstruct the provider request in the renderer.** Rejected: the transcript
  cannot prove which declarations were live for a past request, so the result
  would be an invented prompt presented as fact.
- **Ship the global Usage overview in the same change.** Deferred to a separate
  decision: it needs a Host RPC and a first-party Usage destination, which
  ADR 0173 / D335 currently assign to the `pi.token-insights` plugin.
