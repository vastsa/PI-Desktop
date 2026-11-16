# ADR: S3-only encrypted configuration backup and synchronization

- Status: Accepted; implemented in the S3 configuration-sync change
- Supersedes: The WebDAV transport and compatibility decisions in ADR 0300 and ADR 0301

## Context

A configuration vault must preserve encryption, domain allowlists, device-local
mappings, credential opt-in, approvals, and concurrent-edit safety. The existing
WebDAV compatibility mode required per-device heads and listing/ancestry logic
while still lacking atomic initialization and reliable shared publication.

## Decision

Keep persistence, encryption, merge, scheduling and import ownership in Rust
Host Core. Replace WebDAV with a bounded AWS Signature V4 S3 transport using
maintained cryptographic primitives.

Use separate authenticated `head` and `backup-head` objects. Sync performs
three-way merge and applies remote changes; backup publishes only local
snapshots.

## Alternatives

- Keep WebDAV alongside S3: rejected by the approved S3-only scope and because
  it preserves a second publication and compatibility path.
- Accept ignored conditional headers: rejected because concurrent publication
  can silently lose configuration changes.
- Store SQLite or the entire data directory: rejected because it includes device
  state, credentials and unrelated data rather than portable entities.
- Delete everything outside the 30-entry history index: rejected because
  resource sharing, in-flight publication and offline devices are not proven
  safe by one device's index.

## Consequences

The implementation has one cloud transport and publication model, no server
component, and unchanged process ownership.

Storage can grow indefinitely.
