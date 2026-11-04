# ADR 0340: Let a granted plugin reach every session, not only its imports

- Status: Accepted
- Date: 2026-10-20
- Decision: D680
- Amends: ADR 0200, ADR 0323
- Related: [spec 07-plugins/03 §plugin-owned and host-wide sessions](../spec/07-plugins/03-plugin-api.md) · [13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

`pi.session` was built for external conversation import (ADR 0200): every read
and write is filtered by `session_import_origins.plugin_id`, so a plugin can
only reach sessions it imported itself. That boundary was correct for the
feature it shipped with, and it is now a capability gap.

A plugin that legitimately needs the user's own conversation cannot express it.
The shipped composer-suggestion flow (ADR 0333) reads the session with
`pi.session.getLlmContext`, which only exists inside a plugin tool invocation,
and the alternative — `pi.session.listMessages` — is refused for a session no
plugin imported. The workaround for session titles (ADR 0323) made the gap
explicit: it invented a narrower `session.autoTitle` permission *because* the
existing two could not describe "a plugin may read a user's session". ADR 0323
recorded the rejection in those words.

Meanwhile the platform already accepts the underlying idea: `auto_title_context`
reads any session in the database under a plugin-named permission, and the
`turns`-based `usage.read` listing exposes every session's title and per-turn
counters. The missing piece was never safety — it was a grant name that says
what it grants, so the install review can state it plainly.

The permission model itself already answers the risk question: a plugin is
granted exactly the permissions its manifest declares, the install and update
review lists every one of them and marks the ones an update adds, and a
mismatched grant is refused outright. Consent happens at install, not at each
call.

## Decision

1. Add three permissions — `session.read.all`, `session.update.all`,
   `session.delete.all` — that carry the same three verbs as the `.own` family
   over **every live session**, including the conversations the user created in
   this app.

2. Keep `.own` exactly as it is. `.all` is an addition, never a widening: an
   installed plugin keeps the reach its user reviewed. A manifest may declare
   both, and `.all` wins, because asking for the whole directory and the narrow
   slice at once is asking for the whole directory.

3. Split the enforcement so the ownership predicate stops being a second,
   implicit permission. Electron main resolves the scope from the granted
   permissions and sends the literal `scope` (`"own"` | `"all"`) to host-core;
   host-core enforces exactly the scope it is handed, and an absent parameter
   means `"own"`. Host-core still holds no permission data of its own — the
   ADR 0200 division stays intact — and an unknown `scope` value is an
   `INVALID_PARAMS` error rather than a silent widening.

4. Fix the queries that only worked because the boundary was narrow:
   `list` becomes a `LEFT JOIN` on the origin sidecar so a session with no
   origin row is reachable; `get` reports the real `originKind`, `modelId`,
   `providerId`, and `bound.model` instead of the import projection; messages
   report `origin: "external"` or `"desktop"`; and the `EXISTS` predicates
   inside the `purge` and `trash` statements follow the scope instead of
   hard-coding ownership.

5. Expose message-level writes for the first time, because "modify any content"
   was not a capability `pi.session` had: `appendMessage` and
   `replaceMessages` under `session.update.all`, `deleteMessage` and
   `truncateFrom` under `session.delete.all`. They delegate to the existing
   host-core transcript operations, so revision archiving, inflight
   checkpoints, and the JSONL rewrite path are unchanged. A rewrite is refused
   with `TURN_RUNNING` while a turn owns the session; `appendMessage` is exempt
   because appending is how a turn's own rows land.

6. Keep the brakes that are not about ownership: session delete stays at
   20 calls/minute per plugin, the four message-level writes share a
   60 calls/minute budget, and the existing import limits are untouched.

7. Keep `session.autoTitle` as it is. It stays the narrow title path and does
   not imply a read grant; a plugin that wants the transcript asks for
   `session.read.all` and says so at install.

## Consequences

- A plugin can now read, rename, rewrite, and delete the user's own
  conversations. That is the point, and it is a genuinely high-risk grant: the
  matrix puts all three at `high`, `HIGH_RISK_PERMISSIONS` in the devkit carries
  them, and the runtime-risk map mirrors the matrix so the UI cannot drift.
- `rename` now claims the manual title source. Without that, a `.all` rename of
  a still-default-titled session could be overwritten later by the
  `session.autoTitle` plugin, which would quietly discard a title a plugin — and
  therefore the user — chose.
- A session outside the caller's scope is `NOT_FOUND`, not
  `PERMISSION_DENIED`. The distinction matters: a permission error would let an
  `.own` plugin probe for the existence of sessions it may not see.
- `PluginSessionListItem.externalId` and `PluginSessionGetResult.externalId`
  widen to `string | null`, and `PluginSessionMessageResult.origin` widens to
  `"external" | "desktop"`. Both are read-type widenings: they are `null` (or
  `"desktop"`) only for the sessions a `.all` holder can reach, so `.own`
  consumers see exactly what they saw before.
- Audit records now name the scope that authorised a session call. Before this
  change `plugin.session.list`/`get`/`listMessages`/`rename`/`delete` emitted no
  audit entry at all, which was already a gap; the new breadth makes it
  unacceptable, so every session call audits one line with `scope`.
- The renderer learns which session changed. `sessionsChanged` now carries an
  optional `sessionId`, and the shell re-reads an open transcript when that id is
  the active session and no turn is running. Without it a plugin rewrite would be
  invisible until the user reselected the conversation.
- `sessions::running_turn` becomes crate-visible so the plugin boundary and the
  renderer path share one definition of "a turn owns this session".

## Alternatives considered

### Widen the existing `.own` permissions instead of adding `.all`

Rejected. The install review is the consent surface, and a user who approved
"only the sessions this plugin imported" did not approve "every conversation I
ever had". Silently widening a stored grant changes what an existing install is
allowed to do without anyone agreeing to it, which is exactly the failure the
default-deny rule exists to prevent.

### Route plugin reads through `session.read` (the `getLlmContext` projection)

Rejected. That permission is scoped to an in-flight tool invocation and returns
a compaction-aware projection of the prompt, not a session. Reusing it would
mean either letting a plugin name an arbitrary session id under a grant that
promises no such thing, or keeping the unusable boundary.

### Give the plugin direct session RPC access

Rejected. It hands the plugin a generic host channel and removes the pluginId
provenance the audit relies on. The scope split keeps one endpoint per verb and
keeps Electron main as the only caller that can claim a plugin identity.

### Loosen the ownership filter and let the permission name alone carry the risk

Rejected. Removing the check without a scope would make every existing `.own`
grant a full-grant, which is the first alternative again. The scope parameter is
what keeps old grants old.

### Keep message-level writes out of scope

Rejected for this change. The requirement is "read and modify any session's
content", and a plugin that can rename a session but not append to it still
cannot run the composer-suggestion flow this ADR unblocks. The four methods
delegate to host-core operations the renderer already uses, so the new surface
is a contract and a permission, not a second transcript writer.

### Publish an `expectedRevision` precondition for message writes

Rejected for now. No session-wide revision counter exists; `revision` in this
codebase names a regenerate family, not a transcript version. A precondition
would have to be invented, persisted, and migrated, and a wrong guess would make
legitimate writes fail. `TURN_RUNNING` covers the one concurrent writer that
actually exists — the running turn — and the audit line covers the rest.

## Verification

- `crates/host-core/src/plugin_sessions.rs` unit tests cover scope parsing,
  `.own` regression (a user-created session stays invisible), `.all` reads with
  the corrected metadata, `.all` rename/trash/purge, message-level
  append/replace/delete/truncate, running-turn refusal, and payload bounds.
- `crates/host-core/src/rpc/mod.rs` covers the dispatch: `.own` reports
  `NOT_FOUND`, `.all` serves the same row, an unknown scope is `INVALID_PARAMS`,
  and the four message-level arms round-trip.
- `apps/desktop/test/plugin-session-access.test.mjs` covers the broker policy:
  scope resolution, `.all` winning over `.own`, the message-write grants, and
  payload rejection.
- `apps/desktop/test/plugin-session-api.test.mjs` covers the gateway end to end
  through a real plugin process, including a plugin that tries to set its own
  scope and gets `own` anyway.
