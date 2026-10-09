# ADR: Plugin-managed native transcripts

- Status: Proposed
- Scope: Additive Plugin SDK capability

## Context

A collaboration plugin can create background worker sessions through the reviewed desktop control API, but it cannot maintain a live external transcript in the native conversation surface. Importing snapshots does not provide stable message identities or exclusive routing of later native sends. A native send must never become a local agent prompt when its owning plugin is disabled or unavailable.

## Decision

Add `session.manage.own` with `pi.session.createManaged`, `pi.session.appendManaged`, and the isolated-process `onSessionSubmit` handler. Creation accepts a declared session source, an external identity, title, and optionally an existing host project id. The host generates the session id and records `managed: true` in the existing plugin origin sidecar. Ordinary and imported sessions cannot be claimed. The source/external-id key remains idempotent; a trashed managed session cannot be silently resurrected.

Finalized user, assistant and tool messages use a bounded external identity. The host derives a session-specific message id, validates existing import message constraints, and rejects a reused identity with different content. The optional author is a display label and conveys no permissions. Writes are restricted to the durable owner and refresh native transcripts. Existing JSONL and SQLite facilities remain owned by Rust; no database schema or protocol version change is required.

Before native agent prompting, steering or queue admission, Main reads the durable owner. A managed text send goes only to the owning loaded plugin with its grant. A successful `{ accepted: true }` reply ends the native submission state without starting an agent turn. Missing handlers, invalid replies, unloads and host read failures reject the send. No host replay or fallback is permitted. Agent launch also refuses managed transcripts, including launches originating outside the Composer. Attachments and voice inputs remain unsupported at this boundary.

Add `pi.secrets` with `secrets.store` for encrypted host storage. Main supplies the installed plugin identity and Rust derives the namespace; callers provide only a bounded key and value. Provider credentials and other plugins' keys remain inaccessible. Secret values are never included in audit records or transport error messages.

## Alternatives

A separate work-panel chat would avoid host changes but lose the native conversation requirement. A renderer-only submit callback would not preserve routing after plugin crashes or renderer reload. Reusing arbitrary session replacement would expose other transcripts and make identity conflicts destructive. Snapshot imports remain available for migration and are not changed.

## Compatibility and consequences

All additions require a host version containing this change; a plugin must declare that compatible version in `engines.piDesktop`. Stock 0.17.0 does not contain these capabilities. Existing plugins and ordinary session sends retain their contracts. Disabling or uninstalling a plugin preserves durable transcript ownership, so its conversations remain readable but cannot silently execute locally. Reinstalling and granting the same plugin restores routing. A caller timeout is an uncertain result: plugins must use stable message identities and their own durable admission ledger before returning acceptance.

This capability does not provide a remote transport, permission elevation, arbitrary transcript edits, or hidden execution sessions. Session-scoped execution subscriptions are added separately under the existing `desktop.control` grant. Those behaviors belong to separate capabilities or to the plugin. The room plugin uses ordinary background workers with execution-side native permission cards.

## Verification

Rust tests cover create/append/read, ownership isolation, exact retry, conflict, restart, and trash fencing. Process tests cover SDK invocation, grants, unload and invalid handler results. Router tests cover native text routing, host failure, unavailable owner, concurrent admission and unsupported attachments. An isolated Desktop fixture passed native Composer send, exact append retry, independent author display, native refresh, disabled-owner draft retention, rewrite/steer rejection, durable ownership after process restart, and re-enable. No models or production credentials were used. Session summaries expose a read-only `managedByPlugin` derived from the origin sidecar, so Composer does not require a local model for plugin-managed sends.


## Execution observations and native controls

Session-scoped process subscriptions reuse the native host event outlet rather
than introducing another agent stream. The native window may be absent: delivery
runs before renderer availability checks. Host finalization adds its persistence
acknowledgement to turn notifications; the new subscription reports unknown when
the terminal write is not acknowledged. Existing notification consumers keep the
original terminal reason. Subscriptions never authorize approvals or replay.

The renderer gets two additive declared actions: reading the active chat identity
and opening its own contributed view after a user gesture with an expected session
id. Existing plugin views supply the member surface; no new work-panel lifecycle
or independent chat surface is introduced.


## Managed presentation and main shell contributions

Owned assistant/tool presentation events reuse the native transcript outlet with
stable session-scoped identities. They cannot emit execution lifecycle, permission,
Ask or durable terminal events; finalized messages still require host-core append.
An isolated fixture verified one live-to-final native bubble without a model call.

Additive navigation and main-page slots use the existing renderer registry and
error boundary. A declared, gesture-bound action opens only an owned registered
page. Disposal removes the contribution and reconciles stale routes to chat.
This keeps management in main content while native chat and the existing work
panel remain the conversation and member surfaces. Managed transcript ownership
also excludes duplicate entries from ordinary navigation, search and tray.

A bounded unload window retains current subscriptions and permits terminal append
and private-storage cleanup, while refusing new subscriptions, execution and
managed session creation. Hook completion or deadline closes the window. This
allows durable cancellation to be archived before disconnect without trusting raw
agent terminal frames or allowing cleanup to keep the application alive forever.
