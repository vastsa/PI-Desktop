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

The original implementation kept all grants in memory. The amendment below
supersedes that lifecycle, not the code-only enrollment or its scope.

## Amendment: Remember pairing across Desktop launches (D688)

An app quit is not an explicit revocation. Remember the opt-in and its exact
address and port alongside the paired devices in the local Desktop profile.
Restart only if the same binding is still allowed and available. An explicit
disable, device removal or sign-out durably revokes access; fresh installs
and profiles with no saved opt-in still start off.

Keeping all state in memory requires repeated pairing, while storing reusable
cookie values would unnecessarily expose credentials to anyone who can read
the profile. Store SHA-256 verifiers of random 256-bit cookies instead, limit
browser cookies and server records to 30 days, and retain the existing CSRF
and request checks. This trades a longer credential lifetime on unencrypted
HTTP for reconnect convenience; use it only on trusted networks. Pairing
codes and live connections still die with the process. There is no state to
migrate from the previous version; opt in and pair once after upgrading.
