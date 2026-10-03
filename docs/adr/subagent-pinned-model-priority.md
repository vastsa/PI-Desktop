# ADR: Pinned subagent models take precedence over AI selection

- Status: Proposed
- Date: 2026-09-23
- Amends: D278, ADR subagent-model-opt-in, ADR subagent-model-fallback
- Related: issue #286, ADR 0279, E2E-166

## Context

Task.model currently has higher priority than a definition's model pin. The
parent can pick an opted-in model, or echo its own session model, and replace
the user's explicit configuration before the ordered fallback controller even
starts. A delegation permission is not an instruction to override that pin.
Prompt guidance alone cannot enforce the user's selection.

## Decision

For a new delegation with a model pin, resolve that pin regardless of the
parent's Task.model argument. Ignore a conflicting argument without resolving
or authorizing it, and explain the ignored selection in the Task response.
Repeating the definition's own key stays a quiet no-op. A missing primary
binding still fails before launch instead of using the parent or model pool.

Only unpinned definitions accept the existing opted-in/on-demand Task.model
selection and exact-session-model inheritance exception. The model catalog,
Task definition descriptions, and parameter guidance state this boundary.
No schema, persisted setting, provider permission, or credential path changes.

Keep provider-error recovery unchanged: try only the definition's ordered
fallbackModels after the active model fails under the existing retry policy.
An AI selection cannot replace the primary, reorder the chain, or become a
last-resort fallback. Completed tool work, thinking-level clamping, usage,
cancellation, and exhaustion reporting retain their current semantics.

Resume remains a continuation, not a new model choice: it rejects Task.model
and retains the chain's last valid model, including a successful configured
fallback. This amendment does not silently reset existing chains to a primary.

## Consequences

Existing callers that deliberately overrode a pinned definition will now use
the pin. To permit AI selection, users must explicitly remove the model pin;
to change a fixed workflow, edit its primary/fallback configuration. There is
no automatic migration and no change to stored definitions or prior runs.
The draft proposes an intentional amendment to D278, not a claim that the old
implementation contradicted its documented priority.

## Validation

Runtime tests cover opted-in choices, parent-model echoes, fallback keys,
on-demand/unknown keys, missing primary bindings, and unchanged unpinned
selection. The existing sidecar suite captures real local HTTP requests to
check pin precedence and ordered fallback despite a conflicting AI choice.
The fallback and resume regression suites protect lifecycle behavior. These
fixtures require no commercial provider credentials or paid API calls.
