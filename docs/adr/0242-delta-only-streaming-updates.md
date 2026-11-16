# ADR 0242: Delta-only coalesced streaming updates

- Status: Accepted
- Date: 2026-09-14
- Decision: D412
- Amends: ADR 0127, ADR 0130, ADR 0149, ADR 0153
- Issue: #299

## Context

Long Agent turns streamed at 200+ tokens/s from the provider, but PI-Desktop
displayed them at a much lower rate that got worse the longer the turn ran. Stop
plus a new prompt restored speed; the same turn's later short thinking blocks
stayed slow.

## Decision

Keep `currentAssistant` as the in-memory authority in the runtime. On the
append-only streaming path, emit `message_update` with:

- `stream: "delta"`
- `deltaText` / `deltaThinking`
- `resetText` / `resetThinking` when the provider replaced rather than appended
- a slim `message` identity (id, role, status, createdAt, model/provider,
  parentToolCallId, agentName) without growing `content` / `thinking`

A 16ms coalescer in `DesktopAgentRuntime` concatenates pending deltas and
flushes immediately before `tool_start`, `tool_end`, `message_end`, `error`,
`abort`, retry snapshots, and other semantic events so order is preserved.

- AgentHost patches `activeItems` and skips `JSON.stringify` for small delta
  frames
- Electron main reconstructs the inflight checkpoint snapshot from deltas
- the renderer concatenates same-frame deltas, then patches the live `UiMessage`

## Consequences

- Cross-process streaming bytes grow with the new chunk, not with the cumulative
  snapshot.
- A long turn no longer forms a serialization backlog that later short chunks
  wait behind.
- Historical activity groups in the active turn do not re-render for each tail
  token.
- Crash-recovery checkpoints still see a reconstructed full snapshot.
- Remote RACP `item.delta` payloads match the documented delta contract.

## Alternatives

- Coalesce only in the renderer: rejected; the O(n²) stringify already happened
  in the sidecar and main.
- Drop tokens or raise the debounce to 50ms: rejected; that hides backlog rather
  than removing it.
- New `message_delta` event type: unnecessary; additive fields on the existing
  `message_update` keep old consumers compiling.
