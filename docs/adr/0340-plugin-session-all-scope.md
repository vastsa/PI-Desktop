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

## Decision

1. Add three permissions — `session.read.all`, `session.update.all`,
   `session.delete.all` — that carry the same three verbs as the `.own` family
   over **every live session**, including the conversations the user created in
   this app.

2. Keep `.own` exactly as it is.

3. Split the enforcement so the ownership predicate stops being a second,
   implicit permission.

4. Fix the queries that only worked because the boundary was narrow: `list`
   becomes a `LEFT JOIN` on the origin sidecar so a session with no origin row
   is reachable; `get` reports the real `originKind`, `modelId`, `providerId`,
   and `bound.model` instead of the import projection; messages report `origin:
   "external"` or `"desktop"`; and the `EXISTS` predicates inside the `purge`
   and `trash` statements follow the scope instead of hard-coding ownership.

5. Expose message-level writes for the first time, because "modify any content"
   was not a capability `pi.session` had: `appendMessage` and `replaceMessages`
   under `session.update.all`, `deleteMessage` and `truncateFrom` under
   `session.delete.all`.

6. Keep the brakes that are not about ownership: session delete stays at 20
   calls/minute per plugin, the four message-level writes share a 60
   calls/minute budget, and the existing import limits are untouched.

7. Keep `session.autoTitle` as it is.

## Consequences

- A plugin can now read, rename, rewrite, and delete the user's own
  conversations.
- `rename` now claims the manual title source.
- A session outside the caller's scope is `NOT_FOUND`, not `PERMISSION_DENIED`.
- `PluginSessionListItem.externalId` and `PluginSessionGetResult.externalId`
  widen to `string | null`, and `PluginSessionMessageResult.origin` widens to
  `"external" | "desktop"`.
- Audit records now name the scope that authorised a session call.

## Alternatives considered

### Widen the existing `.own` permissions instead of adding `.all`

Rejected. The install review is the consent surface, and a user who approved
"only the sessions this plugin imported" did not approve "every conversation I
ever had".

### Route plugin reads through `session.read` (the `getLlmContext` projection)

Rejected. That permission is scoped to an in-flight tool invocation and returns
a compaction-aware projection of the prompt, not a session.

### Give the plugin direct session RPC access

Rejected. It hands the plugin a generic host channel and removes the pluginId
provenance the audit relies on.

### Loosen the ownership filter and let the permission name alone carry the risk

Rejected. Removing the check without a scope would make every existing `.own`
grant a full-grant, which is the first alternative again.

### Keep message-level writes out of scope

Rejected for this change.

### Publish an `expectedRevision` precondition for message writes

Rejected for now. No session-wide revision counter exists; `revision` in this
codebase names a regenerate family, not a transcript version.
