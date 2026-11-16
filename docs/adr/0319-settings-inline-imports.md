# ADR 0319: Inline External Imports in Owning Settings Destinations

## Status

Accepted

**Date:** 2026-10-04
**Decision:** D645

## Context

Settings had one Import destination combining four independent workflows:
session import, model configuration import, external skill import, and external
MCP import. The model and agent capability destinations already own the records
those imports create.

## Decision

Remove the standalone Settings Import destination and move external model,
skill, and MCP scan panels into their corresponding Settings pages. Each scan
remains explicit.

Remove the Settings session-import UI. Keep existing plugin session import, host
RPC, IPC, and persistence behavior unchanged.

## Consequences

- The Settings rail and search no longer expose an Import destination.
- Models, Skills, and MCP each expose their importer from their owning page.
- Import candidates and selected rows stay within one capability scope; a scope
  change clears the panel state.
- Existing plugin session import contracts continue to own session ingestion.
- No host protocol, plugin API, permission, or database migration is required.
