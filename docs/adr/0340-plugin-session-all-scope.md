# ADR 0340: Let a granted plugin reach every session, not only its imports

- Status: Accepted
- Date: 2026-10-20
- Decision: D680
- Amends: ADR 0200, ADR 0323
- Related: [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md) ·
  [13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

`pi.session` was built for external conversation import (ADR 0200), so every read
and write is filtered by `session_import_origins.plugin_id` and a plugin can only
reach sessions it imported itself. The composer-suggestion flow (ADR 0333) needs
`pi.session.getLlmContext` and `pi.session.listMessages` refuses a session no
plugin imported, which is why ADR 0323 had to invent the narrower
`session.autoTitle` permission instead of describing "a plugin may read a user's
session".

## Decision

1. Add `session.read.all`, `session.update.all`, and `session.delete.all`, which
   carry the same three verbs as the `.own` family over every live session,
   including conversations the user created in this app.
2. Keep `.own` exactly as it is, since `.all` is an addition and never a
   widening; a manifest may declare both and `.all` wins.
3. Split enforcement so the ownership predicate stops being an implicit second
   permission: Electron main resolves the scope from the granted permissions and
   sends the literal `scope` (`"own"` | `"all"`) to host-core, which enforces
   exactly what it is handed, reads an absent parameter as `"own"`, rejects an
   unknown value with `INVALID_PARAMS`, and still holds no permission data.
4. Fix the queries that only worked because the boundary was narrow: `list`
   becomes a `LEFT JOIN` on the origin sidecar, `get` reports the real
   `originKind`, `modelId`, `providerId`, and `bound.model`, messages report
   `origin: "external"` or `"desktop"`, and the `EXISTS` predicates in `purge`
   and `trash` follow the scope.
5. Expose message-level writes for the first time — `appendMessage` and
   `replaceMessages` under `session.update.all`, `deleteMessage` and
   `truncateFrom` under `session.delete.all` — delegating to the existing
   host-core transcript operations, with a rewrite refused by `TURN_RUNNING`
   while a turn owns the session and `appendMessage` exempt.
6. Keep the brakes that are not about ownership: session delete stays at 20 calls
   per minute per plugin, the four message-level writes share a 60
   calls-per-minute budget, and `session.autoTitle` stays the narrow title path
   that implies no read grant.

## Consequences

- A plugin can read, rename, rewrite, and delete the user's own conversations, a
  genuinely high-risk grant that the matrix, `HIGH_RISK_PERMISSIONS`, and the
  runtime-risk map all classify as `high`.
- `rename` claims the manual title source so a later `session.autoTitle` cannot
  overwrite a chosen title, and a session outside the caller's scope is
  `NOT_FOUND` rather than `PERMISSION_DENIED` so an `.own` plugin cannot probe for
  sessions it may not see.
- `externalId` widens to `string | null` and `origin` to `"external" | "desktop"`
  for `.all` holders only; every session call now audits one line with `scope`,
  and `sessionsChanged` carries an optional `sessionId` so the shell re-reads a
  rewritten active transcript.

## Alternatives considered

- Widen `.own` instead of adding `.all`: a user who approved "only the sessions
  this plugin imported" never approved every conversation.
- Route plugin reads through `session.read` / `getLlmContext`: that grant is
  scoped to an in-flight tool invocation and returns a prompt projection.
- Give the plugin direct session RPC access: it removes the pluginId provenance
  the audit relies on.
