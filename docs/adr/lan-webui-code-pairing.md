# ADR: A one-time code pairs a LAN WebUI device directly

- Status: Accepted
- Date: 2026-11-26
- Supersedes: [Desktop confirmation for LAN WebUI projects](lan-webui-project-access.md)
- Related: [LAN WebUI MVP](../spec/01-product/03-lan-webui-mvp.md), [ADR 0205](0205-remote-agent-control-boundary.md)

## Context

The LAN WebUI is off by default. Enabling it and sharing a locally generated
code were followed by a second device confirmation and optional per-device
grants. The intended personal LAN workflow should need only the code.

## Decision

Redeeming a current, single-use code immediately issues the authenticated
browser session. The same supported local project and temporary-conversation
operations are available to every paired device. Remove the pending state,
confirmation dialog and editable grants. The code dialog discloses the access
it grants, and Desktop still lists and revokes devices.

Keep the private bind, Host/Origin checks, attempt and device limits, cookie
and CSRF validation, and memory-only credentials. Pairing does not issue an
owner or SSH principal or grant generic IPC. Resource eligibility, the remote
`ask` ceiling, and Desktop-only tool and plan approvals are unchanged.

The optional QR encodes only the bound address and the one-time code in a URL
fragment. The browser removes the fragment locally and requires an explicit
submit, so loading or previewing the scanned URL cannot consume the code.

## Consequences

Anyone who obtains an active code can pair without another prompt. Display it
only for an intended device and use the existing plain-HTTP service only on a
trusted LAN. Stop the service or remove a device to revoke access.

No durable grants are migrated. An app restart invalidates existing pairings;
older open browser tabs can still check the issued cookie with `/pair/status`.
