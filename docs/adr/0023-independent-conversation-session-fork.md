# ADR 0023: Independent Conversation Session Fork

## Status

Accepted.

## Context

PI-Desktop already preserves linear regenerate variants within one conversation.
Users also need a Codex-style command that copies the current conversation so
later prompts and configuration changes can diverge without rewriting the
source.

## Decision

- Protocol v5 adds required host RPC `session.fork` and renderer IPC
  `session/fork`.
- The Rust host owns one snapshot operation: by default it copies the source's
  complete active canonical transcript into a new session and remaps message and
  tool-call identifiers.
- The child inherits project, provider, model, mode, thinking, and permission
  mode.
- Referenced existing files under the source session's `scratch/<id>/pasted/`
  directory are copied into the child's own input directory.
- No parent/child lineage is stored.
- Assistant response Fork uses the bounded snapshot directly.
- Whole-session fork remains idle-only.
- A handled file or index failure removes the child transcript and copied inputs
  and leaves no visible child.

## Consequences

- Renderer and host binaries from protocol v4 are rejected during startup
  instead of failing lazily when Create branch is selected.
- Source and child can evolve, reconfigure, persist, and delete independently.
- Fork storage cost is proportional to the active transcript and its referenced
  pasted inputs.
- Message-scoped Fork/Edit storage cost is proportional to the canonical prefix
  through the selected response plus any child-only revision payloads.
- Every child has a new session id and first creates/reseeds its own pi runtime;
  edited context never reuses cache state built from the source transcript.

## Alternatives

- Renderer-owned `create + replaceMessages`: rejected because it is not atomic
  across the host-owned transcript and index.
- Persistent parent/child lineage: deferred because the requested workflow only
  needs an independent copy and D109 keeps message revision navigation linear.
- Copy regenerate revisions: rejected because revision roots and message
  identifiers would require a second branch graph and ambiguous pager history.
