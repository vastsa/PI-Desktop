# ADR: Host-owned trusted-extension model completions

- Status: Proposed implementation for review
- Related: Issue #658, ADR 0174, ADR 0258, spec 07-plugins/16

## Context

The trusted-extension registry only listed the active model and plugin-owned
agents. Extensions could not use a configured reviewer without rebinding the
conversation. Ordinary plugins already have Host-owned independent completions.

## Decision

Expose a synchronous, metadata-only catalog snapshot and an asynchronous
`modelRegistry.complete` on the existing high-trust `agent.extension` surface.
The Host retains credentials, resolves an exact provider/model, rechecks plugin
scope, and calls the shared pi one-shot adapter. The sidecar binds extension
identity to each context and propagates cancellation by request ID. Host-owned
provider snapshots refresh at turn boundaries, including reused runtimes.
Existing registered plugin agents keep their sidecar-owned transport.

The one-shot helper gains an AssistantMessage-returning entry point. Existing
text-only consumers retain their previous extraction and error mapping.
No persistence schema, ordinary plugin permissions or renderer IPC changes.

## Alternatives

Returning raw pi ModelRegistry credentials was rejected: it conflicts with
ADR 0258. Switching the active model was rejected: it mutates conversation
state. A fully asynchronous replacement for existing registry reads would
break extensions; a documented per-turn snapshot preserves compatibility.

## Consequences

The existing high-risk grant now permits spending quota on other configured
providers. Requests have size/rate/time limits and carry explicit caller context;
no transcript is implicitly included. Headless hosts may reject the optional
completion capability. Images and approval-policy changes remain separate work.
