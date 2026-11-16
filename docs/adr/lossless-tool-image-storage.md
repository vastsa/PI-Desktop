# ADR: Lossless tool-image storage and bounded history mutations

- Status: Implemented candidate
- Date: 2026-10-26
- Issue: #1868

## Context

MCP images are duplicated in structured content/details and exact JSON text
mirrors. A normal long screenshot session can exceed the 64 MiB incoming RPC
frame limit when a Desktop action uploads its retained history.

## Decision

Use reversible storage-private per-record image tables and text templates in
Host-owned self-contained files and the Desktop outbox. Decode before business
consumers see the data.

Use additive ID commands for remaining normal history operations and retain the
existing full-upload APIs. Keep the 64 MiB limit and explicit failure semantics.

## Consequences

Images persist once per record without changing visible/plugin/model values.
