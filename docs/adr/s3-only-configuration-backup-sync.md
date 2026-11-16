# ADR: S3-only encrypted configuration backup and synchronization

- Status: Accepted; implemented in the S3 configuration-sync change
- Supersedes: The WebDAV transport and compatibility decisions in ADR 0300 and ADR 0301

## Context

A configuration vault must preserve encryption, domain allowlists, device-local
mappings, credential opt-in, approvals, and concurrent-edit safety. The WebDAV
compatibility mode needed per-device heads and listing ancestry while still
lacking atomic initialization and reliable shared publication, and the approved
direction is direct private S3 storage without a custom cloud service, database
upload, or WebDAV fallback. Users also need a local-snapshot backup mode that
applies no remote changes.

## Decision

Rust Host Core keeps persistence, encryption, merge, scheduling, and import
ownership and replaces WebDAV with a bounded AWS Signature V4 S3 transport on
maintained cryptographic primitives, supporting path-style and virtual-hosted
addressing and session tokens, with a mandatory successful conditional-write
probe and no append-only or unconditional fallback. Separate authenticated
`head` and `backup-head` objects drive three-way merge: sync applies remote
changes, backup publishes only local snapshots, and each head indexes the latest
revisions while immutable objects stay indefinitely. Only the new S3 data format
is supported, with no legacy detection or migration and no deletion of unrelated
old data, under a new `configSyncS3` key namespace with a fresh local state
identity on connection or mode changes and credential reuse bound to the whole
connection identity. Sync restore publishes a new shared revision with explicit
propagation acknowledgment, backup restore applies locally, both save a local
recovery point, and password changes rewrap the same vault key.

## Consequences

- One cloud transport, one publication model, no server component, and unchanged
  process ownership; existing WebDAV users must configure S3 explicitly and
  their old backups stay untouched but cannot be restored through S3.
- Storage can grow indefinitely, and a bucket lifecycle policy that expires
  referenced objects can break synchronization or restore.
- Providers must honor strong ETags and conditional writes, and encryption
  protects contents but not bucket identity, timing, sizes, or traffic patterns.

## Alternatives

- Keep WebDAV alongside S3: rejected, it preserves a second publication path.
- Accept ignored conditional headers: rejected, concurrent publication can
  silently lose configuration changes.
