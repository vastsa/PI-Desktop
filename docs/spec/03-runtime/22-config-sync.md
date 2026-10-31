# Portable configuration sync

Status: implemented S3-only configuration backup and synchronization.

Portable configuration sync is a host-owned, encrypted S3 workflow. It
does not synchronize conversation history, project source files, attachments,
runtime state, or model weights. The Renderer only receives redacted status,
preview counts, conflicts, and activation summaries.

## 1. Ownership and boundaries

The process path remains:

```text
Renderer → Preload IPC → Electron Main → host-core → private S3-compatible bucket
```

Host-core owns the vault key, S3 transport, revision state, merge base,
pending approvals, local encrypted staging, and import application. Electron
Main only registers the IPC handlers and forwards `configSync.changed`.
Agent Runtime has no sync implementation.

The export path is an explicit per-domain allowlist in
`crates/host-core/src/config_sync/domains.rs`. It never serializes the
database, the secrets directory, or an arbitrary filesystem tree. Local paths,
window state, readiness flags, OAuth sessions, plugin binaries, and device
approvals are local overlays or excluded data.
The same module exposes an adapter registry declaring schema version,
portable/secret fields, local overlays, identity and references, merge
granularity, activation, and recovery policy for every supported domain.

## 2. Portable domains

The current adapter set covers application preferences, user-owned providers,
MCP definitions, user skills, global subagents, app-managed global/project
instructions, plugin installation intent, scheduled automations,
and optional project memory. Credentials are opt-in. Provider API keys and MCP
environment variables/headers are included only when the credential category
is selected; OAuth access/refresh tokens and cookies are never exported.
The instruction adapter reads only the fixed global `~/.pi/agent/AGENTS.md`
and each registered project's root `AGENTS.md`; it does not scan nested
repositories or arbitrary files. Imported instruction files are written only
after their scope is explicitly selected, mapped where required, and approved.
Instruction files carry no instruction-specific byte cap; their content is
bounded only by the shared portable-entity payload bound Host checks when it
uploads a revision and when it validates a remote one.
Directory-shaped skills carry bounded sibling resources as authenticated
objects. Package paths, symlinks, collisions, file counts, and total size are
validated by Host before approved resources are written: at most 256 resources
per package, 2 MiB per resource, and 16 MiB per package, while the skill
document itself stays capped at 128 KiB because it can reach a prompt. Scripts
are stored as bytes and are never executed by import.

Project and project-group lists are device-local. Their names, pinning, root
lists, and ordering are not captured or applied by sync or backup, and there is
no projects category. Legacy `projects` entities in existing vault revisions
are ignored during sync and restore; this does not delete local projects or
remote revision history. Project-scoped MCP, skills, instructions, memory, and
automation bindings remain supported through local folder mappings. Receiving
devices register their own projects and groups when those features require a
local workspace.

Project and workspace bindings are represented by opaque logical identifiers.
Host-core assigns a persistent logical identity to each registered standalone
project; project-group roots derive identities from the group identity and
ordered root position. A device mapping overlays the received logical ID onto
its local folder, so different absolute paths do not create duplicate
entities.
Incoming project-scoped executable content stays staged until a local folder
mapping and approval exist. No local path is written into the encrypted
portable entity payload. Plugin data that has no supported adapter is reported
as unsupported rather than treated as synchronized. Approved plugin installation
intent is kept in a Host-owned local overlay; it never pulls plugin bytes or
permission grants.

## 3. Vault and S3 protocol

Each vault has a random data key. The backup password is processed with bounded
Argon2id parameters, and the data key is wrapped with AES-256-GCM. Every head,
revision manifest, and resource object is separately authenticated with a
purpose/vault-derived object key, domain-separated associated data, and a
fresh nonce. Resource object IDs are keyed content identifiers, so plaintext
global hashes are not required. The vault envelope version is independent from
the SQLite schema and is bumped when cryptographic derivation changes.

The remote layout uses one wrapped-key header, two mode-specific encrypted
heads, and immutable authenticated revision/resource objects:

```text
<bucket>/<prefix>/header
<bucket>/<prefix>/vault/<opaque-vault-id>/head
<bucket>/<prefix>/vault/<opaque-vault-id>/backup-head
<bucket>/<prefix>/vault/<opaque-vault-id>/revisions/<revision-id>
<bucket>/<prefix>/vault/<opaque-vault-id>/objects/<object-id>
```

The S3 head format is `pi-desktop-config-sync-s3`, version 1. Each head indexes
at most 30 revisions, newest first. Sync and backup have separate heads,
history, and authentication purposes; neither mode follows an unbounded parent
graph. Immutable objects remain stored indefinitely. This bounds history
queries, **not storage usage**; no physical cloud garbage collection runs.

AWS Signature V4 signs requests, including conditional headers and optional
session tokens. Both path-style and virtual-hosted bucket addressing are
supported. The input uses `endpoint`, `region`, `bucket`, `prefix`,
`accessKeyId`, optional `secretAccessKey`, optional `sessionToken`, and
`pathStyle`. Defaults are `us-east-1`, `pi-desktop/config`, and path style.
The bucket must already exist and remain private; Host never creates it or
changes ACLs. Scope credentials to this bucket/prefix. Normal operation needs
object GET/PUT and deletion of the random probe objects; it does not list the
bucket. A provider may also require scoped ListBucket permission to distinguish
missing objects from access denial.

Initialization uses `If-None-Match: *`; head updates require a strong ETag and
`If-Match`. A rejected precondition restarts reconciliation, never a blind
overwrite. The probe verifies exclusive creation, matching update, stale-write
rejection, and readback, then deletes and verifies its own random object. A
first-create collision is never deleted. Ignored preconditions are unsupported;
there is no WebDAV transport, append-only mode, or unconditional fallback.

Only GET 404 means absent. 403 is an authorization failure; 502 remains an
availability failure. Conditional PUT 409/412 means a lost publication race.
Errors retain stable `CONFIG_SYNC_*` codes without exposing credentials,
request signatures, URLs containing keys, or server response bodies.

Endpoints must be origin-only URLs: no userinfo, query, fragment, or non-root
path. Redirects and public plaintext HTTP are rejected. LAN HTTP is allowed
only by the Host's relaxed network policy, not by a separate sync checkbox.
Connection timeout is 10 seconds, request timeout is 60 seconds, and streamed
objects are capped at 64 MiB. Object paths and prefixes use bounded safe ASCII
segments, not arbitrary S3 key strings; traversal and weak ETags are rejected.

Saved credentials are reused only for the same endpoint, region, bucket,
prefix, access key ID, and addressing style. Omitted secret/token fields mean
reuse; an empty session token clears it. Supplying both fields replaces the
credentials without relying on a readable old secret. Changing the connection
or operating mode creates a new local state identity; pending imports must be
resolved first. Re-saving preserves an existing pause.

## 4. Merge and activation

The encrypted baseline stores both the acknowledged shared revision and its
observed local projection. Credential opt-out and device-local overlays must
not manufacture local edits or block remote deletions. Unacknowledged local
edits are not absorbed when another entity is approved.

In `sync` mode, capture, remote read, three-way merge, immutable upload, CAS
publication, and local application are serialized per vault. Scalar settings
merge by declared entity unit; provider, MCP, skill, and automation records are
not merged as arbitrary arrays. Tombstones carry deletion state and refreshed
digests and remain in subsequent baselines. An unselected category is not a
deletion.

In `backup` mode, a run publishes a local snapshot to `backup-head`. It reads
head metadata for CAS/history but does not download or apply remote
configuration. Multiple devices keep independent snapshots in that history,
not merged configurations. Unchanged snapshots do not create new revisions.

Same edits converge and disjoint edits continue. Same-unit edits and
delete-versus-edit retain both candidates as conflicts. Imported MCP, skills,
subagents, plugins, and automations require local activation approval; an
approval is bound to the entity digest. A changed command, endpoint, script,
instruction, or credential destination therefore invalidates the old approval.
An applied conflict choice records both candidate digests. The next sync
folds that exact unchanged pair into the chosen canonical entity and publishes
it with CAS. Changed candidates still require a new explicit choice.
Missing provider references are retained as dependency approvals instead of
being written as unusable defaults; unrelated entities can continue applying.
The host never activates staged executable content merely because a UI flag is
set. Newly imported automation definitions are also disabled until this
device explicitly takes execution ownership; an existing local task keeps its
device-local enabled state.

The import path rechecks the captured local generation before applying each
entity. Changes made after capture are left in place and are reconciled on the
next run. A durable encrypted pending bundle records the captured local
manifest and an `applying` marker; restart recovery finishes the approved
steps or leaves the bundle visible for retry before the configuration is
considered converged. Existing direct local MCP creation behavior is
unchanged.

Receiving application preferences are filtered through the portable-field
allowlist. Credential opt-out also applies on import, including provider keys
and MCP environment/header fields. Approved skill resource replacement checks
expected content, paths and symlinks, retains unrelated files, and removes only
previously synchronized files omitted by the new package. Each file is replaced
atomically; an import journal is recovery bookkeeping, not a transaction over
the whole filesystem.

## 5. Settings workflow

The Settings → Cloud sync destination is available in development and
packaged builds and carries an Experimental badge on its rail row and page
title. Its visibility does not change the Host-owned sync behavior described
here.

Settings → Cloud sync provides S3 connection fields, a vault password, device
label, `sync` (default) or `backup` mode, automatic-run selection, categories,
connection testing, manual run, unlock, pause, folder mapping, approval/rejection,
history/restore, password rewrap, and disconnect. The renderer displays
`notConfigured`, `locked`, `upToDate`, `localChangesPending`, `syncing`,
`offline`, `unsupportedServer`, `conflict`, `awaitingActivation`, `paused`,
and `error` as distinct states. Disconnect keeps local data and does not delete
remote data.

The page prioritizes status, last success, manual run, pause and inline unlock
above connection editing. Setup shows endpoint, bucket, access key ID, secret
key and vault password; region, prefix, addressing, device label and temporary
token live in a closed Advanced disclosure without changing their defaults.
Saved connections reopen collapsed; unfinished drafts reopen for editing.
Automatic runs use the shared switch. Category choices are available before
the first save inside connection settings, with credentials and memory still
opt-in. History, preview, mappings and security/connection maintenance expand
on demand; errors, manual progress and pending approvals stay visible.
Collapsing content does not reset form values or issue a Host request.

Reopening the page paints cached redacted state/history and a validated,
non-sensitive draft, then refreshes in the background. The S3 draft key is
`pi.desktop.configSyncS3Draft.v1`; old WebDAV drafts are ignored, not deleted.
Only endpoint, region, bucket, prefix, access key ID, addressing style, mode,
device label, automatic-run choice, and categories are persisted. Passwords,
secret access keys, and session tokens remain transient input memory and are
cleared after a successful save. A replacement secret with a blank token sends
an explicit empty token; blank unchanged controls reuse Host credentials.
Changing the saved connection or mode invalidates history and outstanding
history reads. An unsaved mode selection does not change restore behavior.

A manual run reports `capture`, `download`, `merge`, `upload`, and `apply` via
`configSync.progress`; there is no cleanup phase. `done`/`total` count objects
while transferring and entities otherwise. A total of 0 means unknown, and a
`bytesTotal` of 0 means the byte size is unknown, which is the normal case for a
download. Reports are throttled and phase changes are never dropped; the Host
state event and call return are terminal signals. Background polls report
nothing, while a manual Host-owned sync reports progress independent of the view.

`configSync.syncNow` has no aggregate RPC deadline. The Host owns the operation,
so navigating away from Settings does not cancel it. Returning to the page reads
the Host's `syncing` state, disables duplicate actions, and subscribes to the
remaining progress reports. Individual S3 requests retain their own timeouts;
normal Host/process shutdown remains the lifecycle boundary.

Credentials and memory are unchecked by default. The setup preview reports
supported, excluded, secret-bearing, mapping-required, and pending-activation
counts. Raw exported secrets and vault keys are never returned to the renderer;
new connection secrets and backup passwords cross IPC only as transient inputs.

The host owns an immediate startup check, a 30-second local-change debounce,
and a bounded five-minute remote poll when automatic sync is enabled. Failed
network attempts use bounded exponential retry with jitter; paused, locked,
incompatible, authentication, and wrong-password states do not spin retry
loops. The worker is cancelled with the host; there is no extra daemon after
the app exits.

## 6. Durability and compatibility

S3 configuration is stored at `configSyncS3/config` in the Host `kv` store.
The vault key and S3 secret bundle use existing encrypted Host secret storage.
That implementation uses encrypted files and a `.machine-key` in the same data
directory, not an OS Keychain backend; copying the entire data directory is not
a protected cloud backup.

Local state lives under `config-sync/s3/<state-id>/`. The encrypted shared/
observed baseline, pending bundle, and recovery points use temp-file rename.
A malformed or unauthenticated bundle is an error, not an empty state.
Only the new S3 format is supported. Old configuration, credentials and backup
formats are not detected, interpreted or migrated. Existing unrelated files
and cloud objects are not deleted. No SQLite migration is needed.

Restore first saves an encrypted local recovery point. Sync restore requires
`acknowledgePropagation: true` and immediately publishes a new shared revision;
sensitive local activation remains separately approved on each device. Backup
restore is local only and does not move either remote head. The latest backup
can also be restored. Neither mode silently overwrites a pending import.

A password change CAS-updates and authenticates the wrapped-key header without
changing the vault data key. Previously unlocked devices retain access; this
is rewrapping, not device revocation. A fresh device without trusted head
history cannot prove a malicious server returned the newest valid backup.
Availability and freshness against such a server are not guaranteed.

The protocol and connection contracts are intentionally S3-only. All devices
sharing the S3 vault must use this implementation. The former WebDAV backend
and its append-only compatibility mode are removed, not emulated.
See [the S3 decision](../../adr/s3-only-configuration-backup-sync.md).
