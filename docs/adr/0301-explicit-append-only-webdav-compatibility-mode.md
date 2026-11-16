# ADR 0301: Explicit append-only WebDAV compatibility mode

- Status: Superseded by [S3-only configuration backup and sync](s3-only-configuration-backup-sync.md)
- Date: 2026-09-22
- Amends: ADR 0300

This document records the removed WebDAV compatibility design. It is not a
current contract: S3 requires reliable conditional writes, and there is no
append-only fallback. Existing WebDAV data is preserved without migration.

## Context

Some WebDAV servers accept `If-None-Match` and `If-Match` headers but ignore
their preconditions.

## Decision

Keep strict conditional-write mode as the default. Add an explicitly selected
append-only compatibility mode for servers that fail the conditional-write probe
but prove that they can list a WebDAV collection with `PROPFIND`.

## Consequences

Superseded (Superseded by [S3-only configuration backup and sync](s3-only-configuration-backup-sync.md)). The full record is in git history.
