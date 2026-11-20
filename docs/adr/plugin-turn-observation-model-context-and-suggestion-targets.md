# ADR plugin-turn-observation-model-context-and-suggestion-targets: Publish turn observations, scoped model context, and Composer suggestion targets

## Status

Accepted for the additive plugin platform contract in #2470.

## Context

The renderer's message stream, Agent extension hooks, and process plugin API
observe different boundaries. The stream is not proof of a durable user
submission. Trusted extensions can rewrite provider requests, which is more
authority than a plugin needs to provide a project note. Session and turn IDs
alone cannot prove that an empty Composer is still the one the plugin probed.

## Decision

Publish metadata-only, project-scoped process events after registering a
managed turn and after durably inserting its originating user submission. Keep
legacy turn-end delivery unchanged. Use a dedicated, explicitly granted
model-context contribution for bounded reference text, separate from trusted
Agent hooks. Main freezes the contribution set per turn and rechecks grants;
the Agent Runtime projects it onto a request-only copy. Keep grouped draft
suggestions under the existing Composer permission; the host issues a short-lived
plugin-owned target and the renderer verifies the live draft revision.

## Consequences

No internal transcript stream or generic interceptor becomes a plugin contract.
Plugins receiving turn identities do not acquire message access. Optional
contributions add bounded latency and do not survive a turn or a revocation.
Legacy single suggestions remain available, but grouped suggestions require both
host capability discovery and an eligible, still-current Composer target.
