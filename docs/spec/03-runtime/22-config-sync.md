# Portable configuration sync

Status: implemented baseline for the approved WebDAV configuration-sync slice.

Portable configuration sync is a host-owned, encrypted WebDAV workflow. It
does not synchronize conversation history, project source files, attachments,
runtime state, or model weights. The Renderer only receives redacted status,
preview counts, conflicts, and activation summaries.

## 1. Ownership and boundaries

The process path remains:

```text
Renderer → Preload IPC → Electron Main → host-core → WebDAV
```

Host-core owns the vault key, WebDAV transport, revision state, merge base,
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
instructions and projects, plugin installation intent, scheduled automations,
and optional project memory. Credentials are opt-in. Provider API keys and MCP
environment variables/headers are included only when the credential category
is selected; OAuth access/refresh tokens and cookies are never exported.
The instruction adapter reads only the fixed global `~/.pi/agent/AGENTS.md`
and each registered project's root `AGENTS.md`; it does not scan nested
repositories or arbitrary files. Imported instruction files are written only
after their scope is explicitly selected, mapped where required, and approved.
Directory-shaped skills carry bounded sibling resources as authenticated
objects. Package paths, symlinks, collisions, file counts, and total size are
validated by Host before approved resources are written; scripts are stored as
bytes and are never executed by import.

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

## 3. Vault and WebDAV protocol

Each vault has a random data key. The backup password is processed with bounded
Argon2id parameters, and the data key is wrapped with AES-256-GCM. Every head,
revision manifest, and resource object is separately authenticated with a
purpose/vault-derived object key, domain-separated associated data, and a
fresh nonce. Resource object IDs are keyed content identifiers, so plaintext
global hashes are not required. The vault envelope version is independent from
the SQLite schema and is bumped when cryptographic derivation changes.

The remote layout is an opaque header plus immutable revision/resource objects
and one mutable encrypted head:

```text
<selected-directory>/header
<selected-directory>/vault/<opaque-vault-id>/head
<selected-directory>/vault/<opaque-vault-id>/revisions/<revision-id>
<selected-directory>/vault/<opaque-vault-id>/objects/<object-id>
```

Initialization uses `If-None-Match: *`. Existing heads require a strong ETag
and are published with `If-Match`. A failed precondition restarts
reconciliation from the newly read head; it never overwrites blindly. The
capability probe writes a temporary object with conditional creation twice,
obtains a strong ETag, verifies a matching `If-Match` update, and verifies a
stale `If-Match` is rejected before the object is removed.

HTTPS is required by default. Redirects, endpoint userinfo, path traversal,
unsafe remote names, oversized objects, weak ETags, and unbounded KDF
parameters are rejected. An HTTP exception, when exposed by a future UI, must
be an explicit LAN-risk acknowledgement.

## 4. Merge and activation

The local encrypted base is the last acknowledged common revision. Capture,
remote read, three-way merge, immutable object upload, CAS head publication,
and local application are serialized per vault. Scalar settings merge by
declared entity unit; provider records, MCP records, skill packages, and
automation definitions are not merged as arbitrary JSON arrays. Tombstones
represent explicit deletion; an unselected category is not deletion.

Same edits converge and disjoint edits continue. Same-unit edits and
delete-versus-edit retain both candidates as conflicts. Imported MCP, skills,
subagents, plugins, and automations require local activation approval; an
approval is bound to the entity digest. A changed command, endpoint, script,
instruction, or credential destination therefore invalidates the old approval.
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

## 5. Settings workflow

Settings → Cloud sync provides WebDAV endpoint credentials, vault password,
device label, category selection, a capability test, sync-now, unlock, pause,
folder mapping, approval/rejection, revision history/restore, vault-password
rewrap, and disconnect controls. The renderer displays
`notConfigured`, `locked`, `upToDate`, `localChangesPending`, `syncing`,
`offline`, `unsupportedServer`, `conflict`, `awaitingActivation`, `paused`,
and `error` as distinct states. Disconnect keeps local data and does not delete
remote data.

Credentials and memory are unchecked by default. The setup preview reports
supported, excluded, secret-bearing, mapping-required, and pending-activation
counts. Raw secret values, vault keys, and backup passwords never cross the
renderer boundary.

The host owns an immediate startup check, a 30-second local-change debounce,
and a bounded five-minute remote poll when automatic sync is enabled. Failed
network attempts use bounded exponential retry with jitter; paused, locked,
incompatible, authentication, and wrong-password states do not spin retry
loops. The worker is cancelled with the host; there is no extra daemon after
the app exits.

## 6. Durability and compatibility

Sync configuration is stored in the host `kv` namespace. The vault key and
WebDAV password use the existing host secret store. Local base and pending
bundles are encrypted and replaced through temp-file rename. A malformed or
unauthenticated local bundle is an error, not an empty state. Backup format
versioning is independent from the SQLite schema; a newer format is rejected
without truncating the local representation.

Remote history retains the newest 30 reachable logical revisions and protects
the current head, merge base, pending conflict references, and recovery points;
unreferenced objects are deleted only after a grace period and successful
publication. Restore publishes a new revision after a pre-restore encrypted
local recovery point is written. A vault-password change CAS-updates the
wrapped-key header without changing the vault data key; copied old keys are not
cryptographically revoked, so device removal is not treated as revocation.

Project-group mappings accept ordered multi-root bindings and preserve the
primary root invariant. WebDAV tests use an in-process fixture for conditional
creation, strong-ETag updates, stale-writer rejection, empty-vault races, and
weak-ETag rejection. The remaining availability limitation is inherent: a
fresh device without trusted head history cannot prove that a malicious server
returned the newest valid backup.
