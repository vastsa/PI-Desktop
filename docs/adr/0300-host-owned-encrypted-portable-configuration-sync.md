# ADR 0300: Host-owned encrypted portable configuration sync

- Status: Partially superseded by [S3-only configuration backup and sync](s3-only-configuration-backup-sync.md)
- Date: 2026-09-22

The ownership and encryption rationale below remains historical context. The WebDAV
transport, append-only fallback, and endpoint-specific missing-status decisions no
longer describe current behavior; see the S3 decision and the configuration-sync
spec for the implemented contract.

## Context

Portable preferences and user-owned capabilities are spread across Rust-owned
SQLite, capability files, the host secret store, project groups, and plugin
metadata. Copying the database or the secrets directory would export device state,
break ownership boundaries, and could activate executable content on another
machine, while a cloud backup must still converge concurrent edits without trusting
remote timestamps or silently replacing local data.

## Decision

Host-core gains a configuration-sync subsystem built from per-domain capture and
apply adapters, encrypted immutable revision and resource objects, an encrypted CAS
head, and the existing host secret store for the remote password and local vault-key
reference. Argon2id derives a wrapping key from a separate backup password, and
AES-256-GCM authenticates every stored object with purpose/vault-derived keys and
domain-separated associated data. The renderer receives only typed status, preview,
conflict, and activation summaries; Electron Main is a thin lifecycle and transport
bridge.

Portable secrets need explicit opt-in, and OAuth sessions, cookies, local encryption
keys, readiness flags, plugin binaries, arbitrary files, and local paths are not
portable. App-managed instructions cover only the fixed global
`~/.pi/agent/AGENTS.md` and registered project-root `AGENTS.md` files. Imported
executable or security-sensitive content stays staged until the receiving device
approves the entity digest, and project and workspace bindings are local overlays
needing explicit mapping. Project groups use the portable group identity plus
ordered root position, so absolute folder paths never become cross-device identity.

Strict WebDAV initialization and head publication require reliable conditional
writes — `If-None-Match: *` to create, a strong-ETag `If-Match` to update, and a CAS
failure restarts reconciliation — and ADR 0301 defines the separately confirmed
append-only mode for servers that fail the probe, never a silent downgrade to
last-writer-wins. HTTPS is the default; the settings UI may acknowledge LAN HTTP
risk, which Host limits to localhost, `.local`, or private and link-local addresses.

## Consequences

- The renderer and Agent Runtime never touch remote storage, keys, or raw exported
  secrets, existing persistence owners stay authoritative, and immutable revisions
  allow authenticated recovery and deterministic three-way merge.
- Category opt-out stays subscription policy rather than a remote delete, and a fresh
  device cannot activate synchronized executable content without local review.
- A malicious server can still deny availability or roll back a device with no
  trusted head history, and restore cannot revoke a copied vault key.

## Alternatives

- Export SQLite or the data directory, or upload a plaintext JSON backup: leaks
  device state and secrets and cannot express approval or merge policy.
- Last-writer-wins on wall-clock timestamps: loses edits under clock skew and cannot
  resolve delete-versus-edit or executable changes.
- Schedule sync in Electron Main or the renderer: creates a second owner for the
  lifecycle and weakens host durability.
