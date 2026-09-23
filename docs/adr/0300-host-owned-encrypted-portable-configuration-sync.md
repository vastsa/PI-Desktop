# ADR 0300: Host-owned encrypted portable configuration sync

- Status: Accepted for implementation
- Date: 2026-09-22

## Context

PI-Desktop has portable preferences and user-owned capabilities spread across
Rust-owned SQLite, capability files, the host secret store, project groups,
and plugin metadata. Copying the database or the local secrets directory would
export device state, break ownership boundaries, and could activate executable
content on another machine. A cloud backup must also converge concurrent
edits without trusting WebDAV timestamps or silently replacing local data.

## Decision

Add a host-core configuration-sync subsystem. It uses explicit per-domain
capture and apply adapters, encrypted immutable revision/resource objects, an
encrypted CAS head, and the existing host secret store for the WebDAV password
and local vault-key reference. Argon2id derives a wrapping key from a separate
backup password; AES-256-GCM authenticates every stored object with
purpose/vault-derived object keys and domain-separated associated data.

The renderer receives only typed status, preview, conflict, and activation
summaries. Electron Main is a thin lifecycle/transport bridge. Portable
secrets require explicit opt-in; OAuth sessions, cookies, local encryption
keys, readiness flags, plugin binaries, arbitrary files, and local paths are
not portable. App-managed instructions are limited to the fixed global
`~/.pi/agent/AGENTS.md` and registered project-root `AGENTS.md` files; nested
repository files are not scanned. Imported executable or security-sensitive content remains
staged until the receiving device approves the entity digest. Project and
workspace bindings are local overlays and require explicit mapping. Standalone
project identities are assigned and retained by Host metadata; project-group
roots use the portable group identity plus ordered root position, so absolute
folder paths never become cross-device identity.

Strict WebDAV initialization and head publication require reliable conditional
writes: `If-None-Match: *` for creation and strong-ETag `If-Match` for updates.
A CAS failure restarts reconciliation. ADR 0301 defines the separately
confirmed append-only compatibility mode for servers that fail this probe;
there is no silent downgrade to unconditional last-writer-wins. HTTPS is the
default transport; the settings UI may explicitly acknowledge LAN HTTP risk,
and Host restricts that exception to localhost, `.local`, or private /
link-local IP addresses. Public HTTP endpoints remain rejected.

The capability probe may record an endpoint-specific `502 Bad Gateway` response
for a missing object, because some WebDAV gateways use that status instead of
`404`. Only that observed status is treated as absence for subsequent reads;
arbitrary `502` responses are not globally treated as an empty remote. This
compatibility does not change strict mode; servers that ignore conditional-write
headers are supported only through the explicit append-only mode in ADR 0301.

## Consequences

Positive:

- The renderer and Agent Runtime never gain direct access to WebDAV,
  encryption keys, or raw exported secrets.
- Existing local persistence owners remain authoritative; no parallel provider,
  MCP, skill, or subagent database is introduced.
- Immutable revisions allow authenticated recovery and deterministic three-way
  merge, while category opt-out remains subscription policy rather than a
  remote delete.
- A fresh device cannot activate a synchronized command, endpoint, script, or
  automation without local review.

Costs and limits:

- A malicious WebDAV server can still deny availability or roll back a fresh
  device that has no trusted head history; this design protects
  confidentiality and integrity, not availability.
- Folder mappings support ordered multi-root project groups. History/restore,
  backup-password rewrap, bounded Skill package resources, and an in-process
  WebDAV conditional-write fixture are part of the Host-owned baseline. A
  restore creates a new revision and a local recovery point; it does not make
  an old copied vault key revocable.
- Strict conditional-write behavior is stricter than many simple WebDAV
  servers. The explicit append-only mode is a labeled bidirectional
  compatibility path with retained history and weaker publication guarantees;
  it must not be presented as strict CAS.

## Alternatives rejected

1. Exporting SQLite or the application data directory: violates ownership,
   leaks device-specific state, and cannot express approval or merge policy.
2. Uploading a plaintext JSON backup: exposes all configuration and secrets to
   the WebDAV server and every transport intermediary.
3. Last-writer-wins based on wall-clock timestamps: loses edits under clock
   skew and cannot safely resolve delete-versus-edit or executable changes.
4. Scheduling synchronization in Electron Main or the renderer: creates a
   second owner for sync lifecycle and weakens host durability guarantees.
