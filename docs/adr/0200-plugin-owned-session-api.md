# ADR 0200: Host-Owned Plugin Session Import and Ownership API

- Status: Accepted
- Date: 2026-09-09
- Decision: D367
- Amended: 2026-10-20 (ADR 0340 adds the `session.*.all` grants and the
  message-level writes; the ownership boundary below still governs `.own`)

## Context

Plugins need to migrate and inspect conversation history from external tools.
The existing `session.getLlmContext` API is intentionally limited to the
in-flight tool call, while the core `session.import` boundary accepts a host
session summary and can bind a project.

## Decision

Add a separate P0/P1 `pi.session` domain for plugin-owned imported sessions:

- `import`, `importBatch`, `list`, `get`, `listMessages`, `rename`, and `delete`
  are exposed through new plugin permissions and additive host RPC methods.
- A manifest declares `contributes.sessionSources`.
- Host-core generates session, message, and internal tool-call ids.
- Imported sessions default to no active project/provider/model binding.
- `trash` soft-deletes and hides a row while preserving its transcript and
  origin; `purge` cascades the row and removes transcript files.
- The host and Electron runtime enforce bounded content, tool values, payload
  depth, message/batch sizes, strict timestamps, reserved-key scrubbing, and
  per-plugin rolling import/delete limits.
- P2/P3 operations (session creation, message mutation, binding, batch delete,
  and tags) remain deferred and are not represented as permissions.

Schema v14 adds `sessions.deleted_at` and the origin sidecar. The JSON-RPC
protocol remains v11 because these methods are additive and only Electron main
can provide the trusted plugin id.

## Consequences

The plugin API can safely support external-history migration without exposing
SQLite, transcripts, host ids, or another plugin's sessions.

## Amendment (ADR 0340)

The ownership premise above — "a plugin can only query or mutate its own rows" —
is no longer the only boundary the host can express. ADR 0340 adds
`session.read.all`, `session.update.all`, and `session.delete.all`, which carry
the same verbs over every live session, and it adds message-level writes
(`appendMessage`, `replaceMessages`, `deleteMessage`, `truncateFrom`) that this
ADR deferred as P2/P3.

What changes for this ADR:

- Everything here still describes `.own` exactly as written.
- "Host-core generates message ids" no longer holds for a plugin-supplied
  `message.id` used as a retry key; the host still generates the id when the
  caller omits one.
- The P2/P3 deferral in the Decision and Consequences no longer covers message
  mutation.
- Ownership is still enforced in the queries, but no longer always: the P0/P1
  SQL keeps its `plugin_id` predicate only for `.own`, and the `list`, `trash`,
  and `purge` statements now follow the scope Electron sends instead of
  hard-coding it.
