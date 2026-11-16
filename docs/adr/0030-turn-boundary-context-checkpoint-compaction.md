# ADR 0030: Turn-boundary context checkpoint compaction

- Status: Accepted; soft-boundary, model-tool, and visibility clauses
  superseded in part by ADR 0061, then partly restored by ADR 0064
- Date: 2026-07-28
- Last amended: 2026-08-06
- Amended by: ADR 0049 (failure recovery), ADR 0061 (background compaction;
  removes the soft-boundary nudge, the `CompactContext` tool, and the
  visibility of compaction activity), ADR 0064 (Codex parity; compaction is
  inline again, the model-facing tool and budget reminders return, and every
  compaction is visible)

## Context

A long pi agent run can contain many model/tool turns before `agent_end`.
Compacting only between user prompts or after the run is already terminal does
not protect the next provider request inside that loop.

## Decision

PI-Desktop owns its context projection, estimation, compaction preparation and
summary generation, and independently implements the desktop-specific
controller. pi-agent-core supplies the agent loop and stable agent types.

- The controller runs after every `turn_end` and before pi starts another
  provider request.
- Budgeting uses the pi-ai model context/output limits.
- At the soft boundary, a transient system instruction asks the model to call
  `CompactContext` with the active-task focus.
- `CompactContext` bypasses the Rust tool/permission bridge because it changes
  model context, not the workspace.
- At the hard boundary, the runtime generates a checkpoint deterministically.
- A final tool-result batch is kept with its assistant tool-call carrier.
- An exact provider overflow is a final safety net.
- Automatic protection is enabled by default.
- Protocol v6 adds a host-owned `session.appendCompaction` operation and
  compaction lifecycle events.
- Only the newest valid checkpoint rebuilds model context.

## Consequences

- Long tool loops receive context checks at the only boundary that can protect
  the next request without interrupting an active model or tool call.
- The deterministic hard guard does not depend on the model obeying a reminder.
- Restart and model changes retain compacted working context without changing
  the human-readable conversation.
- Compaction itself is one extra provider request and can fail.
- A checkpoint may retain a shortened model-facing copy of an oversized atomic
  tool-result batch.

## Alternatives

### Integrate OpenCode DCP directly

Rejected because it targets OpenCode's plugin hooks and persistence model and is
AGPL-3.0.

### Use pi compaction only at `agent_end`

Rejected because no `agent_end` occurs between tool turns in one long run.

### Rely only on a model reminder

Rejected because the model may ignore, postpone, or repeat the request.

### Delete older visible transcript messages

Rejected because context management must not destroy user history, revision
families, fork inputs, searchability, or diagnostics.

## References

### Implementation note (2026-10-03)

The accepted ownership boundary is unchanged, but pi-agent-core removed its
experimental harness/compaction exports. Agent Runtime now owns the context
projection, conversion, estimation, cut-point preparation, and summary request
adapter; pi-agent-core remains the agent loop and stable type dependency.

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/04-ux/04-builtin-commands.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D158)
- `https://github.com/Opencode-DCP/opencode-dynamic-context-pruning`
