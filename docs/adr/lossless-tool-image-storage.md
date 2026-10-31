# ADR: Lossless tool-image storage and bounded history mutations

- Status: Implemented candidate
- Date: 2026-10-26
- Issue: #1868

## Context

MCP images are duplicated in structured content/details and exact JSON text
mirrors. A normal long screenshot session can exceed the 64 MiB incoming RPC
frame limit when a Desktop action uploads its retained history. Removing details
bytes changes extension inputs; dropping only text mirrors leaves duplication.

## Decision

Use reversible storage-private per-record image tables and text templates in
Host-owned self-contained files and the Desktop outbox. Decode before business
consumers see the data. Preserve existing public RPC/plugin data shapes and old
file reads. Use a backed-up version-only DB migration to prevent older binaries
from silently interpreting the new records. Convert legacy files only at write,
with verified temporary files and atomic replacement.

Use additive ID commands for remaining normal history operations and retain the
existing full-upload APIs. Keep the 64 MiB limit and explicit failure semantics.
Do not introduce external blob ownership, global deduplication or wire compression.

## Consequences

Images persist once per record without changing visible/plugin/model values.
Failed conversion/drain/restore is visible, preserving original files or pending
writes. New code reads legacy data; old applications cannot open the upgraded
profile. Revisions and forks remain self-contained and may each own a copy.
Unique histories over 64 MiB remain usable via IDs, while arbitrary oversized
requests still fail. Validation must prove exact restoration and actual user paths.
