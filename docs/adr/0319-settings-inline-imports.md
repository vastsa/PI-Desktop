# ADR 0319: Inline External Imports in Owning Settings Destinations

## Status

Accepted

**Date:** 2026-10-04
**Decision:** D645

## Context

Settings had one Import destination combining four independent workflows — session,
model configuration, external skill, and external MCP import — although the capability
destinations already own the records those imports create.

## Decision

Remove the standalone Settings Import destination and move the external model, skill,
and MCP scan panels into their owning Settings pages, each staying explicit and using
the selected global or project filter. The Settings session-import UI is removed while
plugin session import, host RPC, IPC, and persistence stay unchanged.

## Consequences

- The Settings rail and search no longer expose an Import destination.
- Each capability exposes its importer from its owning page.
- No host protocol, plugin API, permission, or migration is required.
