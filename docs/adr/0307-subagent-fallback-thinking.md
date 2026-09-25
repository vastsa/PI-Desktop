# ADR 0307: Per-fallback thinking levels for subagents

- Status: Accepted for implementation

## Context

Fallback models can differ in supported reasoning controls. A single subagent thinking setting cannot express a suitable level for each alternative, while an unrestricted UI menu would expose legacy runtime behavior as a new choice.

## Decision

Allow a thinking-level suffix on each fallback model pin. The editor uses a fixed menu of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, with no selectable `omit`; no suffix inherits the definition's thinking setting or the parent selection if unset. Preserve existing `|omit` entries for compatibility. At execution, clamp the requested level to the selected model's supported capability.

## Consequences

Fallback pins remain flat strings and retain their order. Runtime capability, not the editor, determines the effective level supported by a provider/model.
