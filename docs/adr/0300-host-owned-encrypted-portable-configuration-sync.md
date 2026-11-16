# ADR 0300: Host-owned encrypted portable configuration sync

- Status: Partially superseded by [S3-only configuration backup and sync](s3-only-configuration-backup-sync.md)
- Date: 2026-09-22

The ownership and encryption rationale below remains historical context. The
WebDAV transport, append-only fallback, and endpoint-specific missing-status
decisions no longer describe current behavior. See the S3 decision and current
configuration-sync spec for the implemented contract.

## Context

PI-Desktop has portable preferences and user-owned capabilities spread across
Rust-owned SQLite, capability files, the host secret store, project groups, and
plugin metadata. Copying the database or the local secrets directory would
export device state, break ownership boundaries, and could activate executable
content on another machine.

## Decision

Add a host-core configuration-sync subsystem. It uses explicit per-domain
capture and apply adapters, encrypted immutable revision/resource objects, an
encrypted CAS head, and the existing host secret store for the WebDAV password
and local vault-key reference.

The renderer receives only typed status, preview, conflict, and activation
summaries. Electron Main is a thin lifecycle/transport bridge.

## Consequences

Positive:

- The renderer and Agent Runtime never gain direct access to WebDAV, encryption
  keys, or raw exported secrets.
- Existing local persistence owners remain authoritative; no parallel provider,
  MCP, skill, or subagent database is introduced.
- Immutable revisions allow authenticated recovery and deterministic three-way
  merge, while category opt-out remains subscription policy rather than a remote
  delete.
- A fresh device cannot activate a synchronized command, endpoint, script, or
  automation without local review.

Costs and limits:

- A malicious WebDAV server can still deny availability or roll back a fresh
  device that has no trusted head history; this design protects confidentiality
  and integrity, not availability.

## Alternatives rejected

1. Exporting SQLite or the application data directory: violates ownership, leaks
   device-specific state, and cannot express approval or merge policy.
2. Uploading a plaintext JSON backup: exposes all configuration and secrets to
   the WebDAV server and every transport intermediary.
3. Last-writer-wins based on wall-clock timestamps: loses edits under clock skew
   and cannot safely resolve delete-versus-edit or executable changes.
4. Scheduling synchronization in Electron Main or the renderer: creates a second
   owner for sync lifecycle and weakens host durability guarantees.
