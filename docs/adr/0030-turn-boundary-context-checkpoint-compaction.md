# ADR 0030: Turn-boundary context checkpoint compaction

- Status: Accepted; soft-boundary, model-tool, and visibility clauses superseded in
  part by ADR 0061, then partly restored by ADR 0064
- Date: 2026-07-28
- Related: D158, ADR 0049, ADR 0061, ADR 0064

## Context

One pi agent run can contain many model/tool turns before `agent_end`, and compacting
only between user prompts or after the run is terminal does not protect the next provider
request inside that loop: an observed request exceeded the provider maximum and was
rejected before any recovery point existed. The context helpers pi-agent-core once
exported were removed, so the desktop runtime has to own projection, estimation, and
summary generation while pi keeps the loop and its stable agent types.

## Decision

PI-Desktop owns context projection, estimation, compaction preparation, and summary
generation, and the controller runs after every `turn_end` — the model and tool turn
boundary — before pi starts another provider request. Budgeting uses pi-ai model context
and output limits, with request headroom of the configured reserve, the model output
allowance, or a share of the window, bounded so reserve and retained tail each stay below
half the hard budget (ADR 0064 derives both from the model window and retains only recent
user messages; ADR 0061 removed the soft-boundary nudge and the `CompactContext` tool, and
ADR 0064 restored the tool as `new_context` with budget notices instead of a transient
instruction). At the hard boundary the runtime generates a checkpoint deterministically
and re-estimates before persistence and before continuation, and a failed summary or
ineffective checkpoint first tries ADR 0049's retained-tail recovery before the loop stops
with `CONTEXT_COMPACTION_FAILED`. A final tool-result batch stays with its assistant
tool-call carrier, and an atomic batch that reaches the hard budget becomes a
checkpoint-only bounded copy keeping each result's tool identity and error envelope plus
an explicit truncation marker, while durable messages and the visible transcript stay
complete. An exact provider overflow is the last safety net: the failed assistant leaves
model context, one checkpoint is created, the request is retried once, and a second
overflow is terminal. Protocol v6 adds a host-owned `session.appendCompaction` operation
and compaction lifecycle events, so the host appends a typed checkpoint line to the session
JSONL and never deletes, rewrites, or hides visible messages; only the newest valid
checkpoint rebuilds model context, transcript rewrites keep it only while its boundary
remains, forks copy and remap it only when the fork includes that boundary, and stored
`enabled: false` values are ignored because protection is always on.

## Consequences

- Long tool loops get a context check at the only boundary that protects the next request
  without interrupting an active call, and the deterministic hard guard does not depend on
  the model obeying a reminder.
- Compaction costs one extra provider request and can fail: automatic failure has a durable
  retained-tail recovery, while manual `/compact` stays fail-fast for an idle session.
- A checkpoint may keep a shortened model-facing copy of an oversized tool-result batch, so
  future model detail is lost under pressure but every call/result pair survives, and
  provider token accounting on retained assistant messages is cleared when a checkpoint is
  reconstructed.

## Alternatives

- Compact only at `agent_end`: no `agent_end` occurs between tool turns.
- Rely on a model reminder alone: the model may ignore it, so the hard boundary stays the
  enforcement point.
