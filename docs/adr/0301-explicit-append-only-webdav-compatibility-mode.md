# ADR 0301: Explicit append-only WebDAV compatibility mode

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: ADR 0300

## Context

Some WebDAV servers accept `If-None-Match` and `If-Match` headers but ignore
their preconditions. Treating a successful unconditional `PUT` as a compare-
and-swap would allow two devices to overwrite a shared head without detecting
the race. CloudDrive-style WebDAV endpoints are useful for local-network sync,
but a server's WebDAV support does not by itself prove conditional-write
semantics.

## Decision

Keep strict conditional-write mode as the default. Add an explicitly selected
append-only compatibility mode for servers that fail the conditional-write
probe but prove that they can list a WebDAV collection with `PROPFIND`.

Compatibility mode uses the same encrypted header, immutable revision manifests,
and authenticated resources as strict mode, but changes publication as follows:

1. Each device receives a random stable device identifier.
2. Each device publishes only its own encrypted pointer at
   `vault/<vault-id>/heads/<device-id>`; the pointer is verified by a readback.
3. A sync lists all device pointers, includes a legacy strict head when present,
   walks their bounded parent graph, removes ancestor pointers, and merges all
   remaining tips against the last acknowledged base.
4. New revisions and resources use unique immutable identifiers. Existing
   resources are read and authenticated before reuse; compatibility mode does
   not overwrite an existing immutable object.
5. Compatibility mode retains immutable remote history and does not run remote
   cleanup, because a server without conditional writes cannot provide a safe
   cross-device acknowledgement protocol.

The settings page labels the mode as compatibility mode, explains that it does
not provide atomic compare-and-swap, and requires confirmation before saving.
All devices sharing a vault must select the same mode. The mode is not a silent
downgrade, and a server that cannot prove directory listing remains unsupported
for bidirectional synchronization.

## Consequences

- Concurrent writers publish separate tips instead of silently overwriting one
  shared head; compatible disjoint edits can still converge through the normal
  merge engine.
- A device with a duplicated device identifier or a server that changes a
  device pointer during readback is reported as a conflict rather than treated
  as converged.
- Compatibility mode is not equivalent to strict CAS. A server can still lose
  an in-flight unconditional write, deny or roll back availability, race vault
  header initialization, or return an incomplete directory listing. The UI
  discloses these limits and history is retained to make recovery possible.
- New-device executable imports remain staged behind the existing digest-bound
  approval boundary; selecting compatibility mode does not grant activation.
- Password rewrap updates the encrypted header unconditionally in this mode and
  verifies the resulting header. Rotation of a copied vault key still requires
  vault re-encryption and server-credential rotation.

## Alternatives rejected

1. Silently accepting ignored preconditions: unsafe last-writer-wins behavior
   and data loss under concurrent sync.
2. Keeping one shared mutable head with an unconditional `PUT`: the exact race
   this mode is intended to avoid.
3. Treating every WebDAV `GET` failure as an empty collection: hides outages and
   can cause accidental reinitialization. Only the endpoint-specific observed
   missing-object status remains compatible.
