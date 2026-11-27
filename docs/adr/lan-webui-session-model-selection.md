# ADR: Paired LAN WebUI devices can select a session model

- Status: Accepted
- Date: 2026-11-27
- Related: [LAN WebUI pairing](lan-webui-code-pairing.md), [LAN WebUI MVP](../spec/01-product/03-lan-webui-mvp.md)

## Context

A person continuing work on the phone needs to choose a model before sending.
Sending provider configuration to the browser would expose details unrelated to
that choice. A per-message override would also make the two clients disagree
about which model the conversation uses next.

## Decision

Expose a scoped list and a model-only mutation for an idle, ordinary local
Agent session. Use Desktop's saved Composer bindings and local cached model
metadata; the browser receives only provider/model IDs and display labels, and
cannot initiate provider discovery. Validate the selection against the same
catalog on write. Keep configuration at the Host through `session.configure`;
a compare-before-write guard rejects a concurrently moved, reconfigured, or
repurposed session. Mode, reasoning, permissions and global settings are not
part of the browser request.

## Consequences

Both clients see the saved binding and use it for the next turn. The phone
cannot configure providers, start privileged work, or change running/queued
sessions through the picker. Pairing, the WebUI permission ceiling and storage
ownership are unchanged. The browser endpoints and Host guard are additive;
existing sessions and provider records need no migration.
