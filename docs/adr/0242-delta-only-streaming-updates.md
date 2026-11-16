# ADR 0242: Delta-only coalesced streaming updates

- Status: Accepted
- Date: 2026-09-14
- Related: D412, ADR 0127, ADR 0130, ADR 0149, ADR 0153, issue #299

## Context

Long agent turns streamed at high token rates but displayed more slowly the longer
the turn ran, and subagents showed the same lag: each `message_update` flattened the
full assistant snapshot, compared it against the accumulated string, serialized the
whole `UiMessage` onto sidecar stdout, and AgentHost `boundPayload()` stringified it
again for frame-size checks before renderer batching ran, so a length-n stream cost
about O(n²) bytes and CPU. RACP already documents `item.delta` as non-durable delta
text with the full row in `item.completed`.

## Decision

`currentAssistant` stays the in-memory authority: on the append-only streaming path
`message_update` carries `stream: "delta"`, `deltaText` / `deltaThinking`,
`resetText` / `resetThinking` when the provider replaced rather than appended, and a
slim `message` identity (id, role, status, createdAt, model/provider,
parentToolCallId, agentName) without growing `content` / `thinking`. A 16ms
coalescer in `DesktopAgentRuntime` concatenates pending deltas and flushes
immediately before `tool_start`, `tool_end`, `message_end`, `error`, `abort`, and
retry snapshots, so order is preserved; `message_start` and `message_end` still carry
a full `UiMessage`, and snapshot replacements omit `stream` while replacing the live
row. AgentHost patches `activeItems` and skips serialization for small delta frames,
Electron main reconstructs the inflight checkpoint from deltas, and the transcript
projection reuses unchanged activity parts with stable delegation status and timing
`Map`s, passing `runtimeActivity` only to the live tail ActivityGroup. Protocol
version stays 11 and the fields are additive, so consumers that ignore `stream` still
get `message_end` as the authoritative row.

## Consequences

- Cross-process streaming bytes grow with the new chunk rather than the cumulative
  snapshot, so a long turn no longer forms a serialization backlog.
- Historical activity groups stop re-rendering per tail token, while crash-recovery
  checkpoints still see a reconstructed full snapshot.
- Remote RACP `item.delta` payloads match the documented delta contract.

## Alternatives

- Coalesce only in the renderer: the O(n²) stringify already happened in the sidecar
  and main.
- Add a `message_delta` event type: additive fields keep old consumers compiling.
