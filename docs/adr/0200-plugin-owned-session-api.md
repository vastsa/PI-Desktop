# ADR 0200: Host-Owned Plugin Session Import and Ownership API

- Status: Accepted (D367; amended 2026-10-20 by ADR 0340, which adds the
  `session.*.all` grants and message-level writes while `.own` stays as below)
- Date: 2026-09-09
- Related: D367, ADR 0201, ADR 0340

## Context

Plugins need to migrate and inspect conversation history from external tools, but
`session.getLlmContext` is limited to the in-flight tool call and the core
`session.import` boundary accepts a host session summary and can bind a project, so
reusing either shape would let a plugin choose a core session identity or create
project records outside its ownership boundary.

## Decision

A separate P0/P1 `pi.session` domain owns plugin-imported sessions: `import`,
`importBatch`, `list`, `get`, `listMessages`, `rename`, and `delete` are exposed
through new plugin permissions and additive host RPC methods, and a manifest
declares `contributes.sessionSources`, which the Electron permission gateway
validates before host dispatch. Host-core generates session, message, and internal
tool-call ids, keys idempotency by `(pluginId, source, externalId)` in
`session_import_origins`, and limits a plugin to its own rows. ADR 0201 adds an
explicit host-created project-id opt-in; imported sessions otherwise start with no
active project/provider/model binding, and original values stay history JSON for
inspection rather than live authorization. `trash` soft-deletes and hides a row
while preserving transcript and origin, and `purge` cascades the row and removes
transcript files, under bounded content, tool values, payload depth, message and
batch sizes, strict timestamps, reserved-key scrubbing, and per-plugin rolling
import/delete limits.

P2/P3 operations (session creation, message mutation, binding, batch delete, tags)
remain deferred and are not represented as permissions; schema v14 adds
`sessions.deleted_at` and the origin sidecar, while JSON-RPC stays at v11 because
these methods are additive and only Electron main can provide the trusted plugin
id. ADR 0340 later adds `session.read.all`, `session.update.all`, and
`session.delete.all` over every live session plus the message-level writes
(`appendMessage`, `replaceMessages`, `deleteMessage`, `truncateFrom`); `.all` is a
separate install-time grant that wins only when a manifest declares both, and the
`plugin_id` predicate now applies only to `.own`.

## Consequences

- The plugin API supports external-history migration without exposing SQLite,
  transcripts, host ids, or another plugin's sessions.
- The storage layer gains one migration and a soft-delete state that core session
  lists must exclude, and future P2/P3 work must extend this ownership model rather
  than reuse the core import.

## Alternatives

- Reuse the core `session.import` boundary: lets a plugin choose a core identity and
  create project records outside its boundary.
- Widen `session.getLlmContext`: it is limited to the in-flight tool call.
