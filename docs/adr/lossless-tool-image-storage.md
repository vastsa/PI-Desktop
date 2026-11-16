# ADR: Lossless tool-image storage and bounded history mutations

- Status: Implemented candidate
- Date: 2026-10-26
- Issue: #1868

## Context

MCP images are duplicated in structured content/details and exact JSON text
mirrors, so a long screenshot session can exceed the 64 MiB incoming RPC frame
limit when Desktop uploads its retained history.

## Decision

Store each image once per record in reversible, storage-private image tables and
text templates inside Host-owned self-contained files and the Desktop outbox, and
decode before business consumers see the data. Public RPC/plugin shapes, legacy
file reads, and the 64 MiB limit with explicit failure semantics stay unchanged;
a backed-up version-only DB migration keeps older binaries from misreading new
records, and legacy files convert only at write through verified temporary files
with atomic replacement. Remaining history operations use additive ID commands
next to the existing full-upload APIs.

## Consequences

- Visible, plugin, and model values are unchanged; revisions and forks stay
  self-contained and may each own a copy.
- New code reads legacy data, while older applications cannot open the upgraded
  profile.
- Unique histories beyond 64 MiB stay usable through IDs; arbitrary oversized
  requests still fail.
