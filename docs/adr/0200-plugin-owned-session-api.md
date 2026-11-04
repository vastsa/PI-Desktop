# ADR 0200: Host-Owned Plugin Session Import and Ownership API

- Status: Accepted
- Date: 2026-09-09
- Decision: D367
- Amended: 2026-10-20 (ADR 0341 adds the `session.*.all` grants and the
  message-level writes; the ownership boundary below still governs `.own`)

## Context

Plugins need to migrate and inspect conversation history from external tools.
The existing `session.getLlmContext` API is intentionally limited to the
in-flight tool call, while the core `session.import` boundary accepts a host
session summary and can bind a project. Reusing either shape would let a plugin
choose a core session identity or create project records outside its ownership
boundary.

## Decision

Add a separate P0/P1 `pi.session` domain for plugin-owned imported sessions:

- `import`, `importBatch`, `list`, `get`, `listMessages`, `rename`, and `delete`
  are exposed through new plugin permissions and additive host RPC methods.
- A manifest declares `contributes.sessionSources`. The Electron permission
  gateway rejects undeclared sources before host dispatch.
- Host-core generates session, message, and internal tool-call ids. The
  idempotency key is `(pluginId, source, externalId)` in
  `session_import_origins`; a plugin can only query or mutate its own rows.
- Imported sessions default to no active project/provider/model binding.
  ADR 0201 adds an explicit host-created project-id opt-in; original values
  are retained as history JSON for inspection, not used as live authorization
  or execution configuration.
- `trash` soft-deletes and hides a row while preserving its transcript and
  origin; `purge` cascades the row and removes transcript files. Purging a
  trashed row remains available to its owning plugin.
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
SQLite, transcripts, host ids, or another plugin's sessions. The storage layer
gains one migration and a soft-delete state that normal core session lists must
exclude. Future P2/P3 work must extend this ownership model rather than reuse
the core session importer.

## Verification

Coverage includes manifest/source validation, runtime permission and payload
checks, host idempotency, batch skip/rollback semantics, ownership filtering,
list/get/rename, message paging/truncation, tool reserved-key scrubbing,
trash-to-purge lifecycle, migration-compatible schema creation, and rate
limits. Full UI E2E execution remains deferred per repository policy; scenarios
E2E-214 and E2E-215 are recorded in the E2E plan.

## Amendment (ADR 0341)

The ownership premise above — "a plugin can only query or mutate its own rows" —
is no longer the only boundary the host can express. ADR 0341 adds
`session.read.all`, `session.update.all`, and `session.delete.all`, which carry
the same verbs over every live session, and it adds message-level writes
(`appendMessage`, `replaceMessages`, `deleteMessage`, `truncateFrom`) that this
ADR deferred as P2/P3.

What changes for this ADR:

- Everything here still describes `.own` exactly as written. An installed plugin
  keeps that reach; `.all` is a separate grant that a user approves at install,
  and it wins only when a manifest declares both.
- "Host-core generates message ids" no longer holds for a plugin-supplied
  `message.id` used as a retry key; the host still generates the id when the
  caller omits one.
- The P2/P3 deferral in the Decision and Consequences no longer covers message
  mutation. Session creation, arbitrary re-binding, provider/model binding,
  batch delete, and tags remain deferred.
- Ownership is still enforced in the queries, but no longer always: the P0/P1
  SQL keeps its `plugin_id` predicate only for `.own`, and the `list`,
  `trash`, and `purge` statements now follow the scope Electron sends instead
  of hard-coding it.

See [ADR 0341](0341-plugin-session-all-scope.md) for the decision, the risk
argument, and the alternatives.
