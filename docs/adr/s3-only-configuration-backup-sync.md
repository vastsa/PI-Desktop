# ADR: S3-only encrypted configuration backup and synchronization

- Status: Accepted; implemented in the S3 configuration-sync change
- Supersedes: The WebDAV transport and compatibility decisions in ADR 0300 and ADR 0301

## Context

A configuration vault must preserve encryption, domain allowlists, device-local
mappings, credential opt-in, approvals, and concurrent-edit safety. The existing
WebDAV compatibility mode required per-device heads and listing/ancestry logic
while still lacking atomic initialization and reliable shared publication.
The approved direction is direct private S3 storage, without a custom cloud
service, database upload, or WebDAV fallback.

Users also need a local-snapshot backup mode that does not apply remote changes.
Shared resource reuse and offline devices make physical garbage collection
unsafe without a separate cross-device retention protocol.

## Decision

Keep persistence, encryption, merge, scheduling and import ownership in Rust
Host Core. Replace WebDAV with a bounded AWS Signature V4 S3 transport using
maintained cryptographic primitives. Support path-style and virtual-hosted
addressing and session tokens, but require a successful conditional-write probe
for every service. There is no append-only or unconditional fallback.

Use separate authenticated `head` and `backup-head` objects. Sync performs
three-way merge and applies remote changes; backup publishes only local
snapshots. Each head indexes the latest 30 revisions. Keep immutable objects
indefinitely instead of claiming that a bounded history index bounds storage.

Support only the new S3 data format, without legacy detection or migration.
Do not delete unrelated old data. S3 uses a new `configSyncS3` key namespace
and a fresh local state identity on connection or mode changes. Credential
reuse is bound to the complete connection identity.
Retain both shared and observed baselines so device-local projections and
credential opt-out do not become false edits.

Sync restore publishes a new shared revision with explicit propagation
acknowledgment. Backup restore applies locally without changing cloud history.
Both save a local recovery point and preserve activation review. Password
changes rewrap the same vault key; they do not revoke previously unlocked
devices.

## Alternatives

- Keep WebDAV alongside S3: rejected by the approved S3-only scope and because
  it preserves a second publication and compatibility path.
- Accept ignored conditional headers: rejected because concurrent publication
  can silently lose configuration changes.
- Store SQLite or the entire data directory: rejected because it includes
  device state, credentials and unrelated data rather than portable entities.
- Delete everything outside the 30-entry history index: rejected because
  resource sharing, in-flight publication and offline devices are not proven
  safe by one device's index.
- Add a hosted coordination service: unnecessary for the bounded conditional
  object protocol and outside the approved direct-storage design.

## Consequences

The implementation has one cloud transport and publication model, no server
component, and unchanged process ownership. Existing WebDAV users must configure
S3 explicitly; their old cloud backups remain untouched and cannot be restored
through the new S3 transport. Applications sharing a vault must use the S3
contract together.

Storage can grow indefinitely. A bucket lifecycle policy that expires referenced
objects can break synchronization or restore; the application does not claim to
make arbitrary lifecycle deletion safe. Providers must honor strong ETags and
conditional writes; compatibility is established by the actual endpoint probe,
not a vendor label.

The existing Host secret store uses encrypted files plus a colocated machine
key, not OS Keychain protection. Remote encryption protects configuration
contents but does not hide bucket identity, request timing, object sizes or
traffic patterns. A malicious server can deny service or replay old valid state
to a fresh device. A local import journal and per-file atomic replacement are
not a whole-filesystem transaction.

The current behavioral contract is
[Portable configuration sync](../spec/03-runtime/22-config-sync.md), and
executable transport, merge, application and multi-device tests remain the
source of truth.
