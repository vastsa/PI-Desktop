# ADR 0301: Explicit append-only WebDAV compatibility mode

- Status: Superseded by [S3-only configuration backup and sync](s3-only-configuration-backup-sync.md)
- Date: 2026-09-22
- Amends: ADR 0300

## Context

Some WebDAV servers accept `If-None-Match` and `If-Match` but ignore the
preconditions, so treating an unconditional `PUT` as a compare-and-swap would let
two devices overwrite a shared head without detecting the race. A server's WebDAV
support does not by itself prove conditional-write semantics.

## Decision

Strict conditional writes stayed the default, and an explicitly selected
append-only compatibility mode existed for servers that failed the
conditional-write probe but could list a collection with `PROPFIND`. Each device
received a random stable identifier and published only its own encrypted pointer
under `vault/<vault-id>/heads/<device-id>`; a sync listed every device pointer,
walked their bounded parent graph, dropped ancestor pointers, and merged the
remaining tips against the last acknowledged base. Revisions and resources used
unique immutable identifiers, the mode retained remote history without cleanup, and
all devices sharing a vault had to select the same mode.

This design is retired. S3-only configuration backup and sync requires reliable
conditional writes and keeps no append-only fallback; existing WebDAV data is
preserved without migration.
