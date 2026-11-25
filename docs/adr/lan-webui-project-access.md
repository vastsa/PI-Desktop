# ADR: Device confirmation grants access to all local LAN WebUI projects

- Status: Accepted
- Date: 2026-11-26
- Related: [ADR 0205](0205-remote-agent-control-boundary.md), [LAN WebUI MVP](../spec/01-product/03-lan-webui-mvp.md)

## Context

The LAN companion is an opt-in view of the running Desktop. Per-project
allowlists made each new device pairing depend on a second selection, and new
local projects remained hidden from already paired devices.

## Decision

The local user still confirms each browser after one-time code pairing. That
confirmation explicitly grants visibility of the current and future eligible
local projects, including archived history, without an individual checklist.
The Desktop edge reads the current local catalog for requests; it does not
snapshot project IDs or include SSH-backed projects. Temporary conversations
remain off by default, and the Chat and Organize grants and the remote `ask`
ceiling still apply. Transport, process ownership, and the RACP role model do
not change.

## Consequences

A paired device can read a newly registered local project without another
prompt. Keep this visible at confirmation and remove devices that should no
longer share the Desktop's projects. Keep the listener off on untrusted networks.

The private LAN admin contract and the WebUI's access metadata replace the MVP's
project ID list with an explicit `all-local` scope marker. Stale confirmation
or update requests without the marker fail closed. Pairings are memory-only;
updating/restarting Desktop requires a fresh confirmation, not a persisted grant
migration.
