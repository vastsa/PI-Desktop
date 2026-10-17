# ADR 0327: Automatic remote Host version realignment

- Status: Accepted for experimental implementation (amends ADR 0326 item 6: daily startup is still not an installer, but a version mismatch is now repaired instead of only reported)
- Date: 2026-10-12
- Deciders: PI-Desktop maintainers (user-authorized fix for a paired Host that could not be upgraded)
- Related: [ADR 0326](0326-verified-ssh-host-installation.md), [ADR 0292](0292-ssh-remote-host-bootstrap.md), [ADR 0293](0293-ssh-password-authentication.md), [architecture §5.2](../spec/02-architecture/05-remote-agent-control.md#52-remote-host-over-an-ssh-tunnel-first-remote-topology), [security §3.4](../spec/05-security/02-remote-control-security.md#34-ssh-bootstrap-pairing-first-remote-topology)

## Context

A paired Host is pinned to the desktop release that installed it. The bundle is
reused only when its external receipt and every installed file still match, and
the daily readiness probe refuses a Host whose reported version differs from the
one the desktop expects.

Two gaps made that refusal a dead end:

1. The probe compared the running Host against the version **recorded when the
   host was paired**, not against the desktop release. A descriptor written by an
   older desktop made the comparison wrong in both directions: a Host that had
   been upgraded was still refused, and a Host that was behind could pass on a
   stale record until a later capability check failed.
2. Nothing in the product could upgrade a paired Host. The only remedy was to
   remove the host and pair it again, which discards a working SSH descriptor and
   its encrypted credential.

The visible result was a "upgrade the remote Host to a matching Desktop release"
toast with no action behind it — the exact reported failure. A related case
compounds it: an installed bundle can report the *same* version and still predate
an additive capability the desktop now requires (remote workspace tools and
files), because reuse is keyed on the release receipt, not on capabilities. That
mismatch is observable only in the RACP handshake.

## Decision

1. Readiness compares the running Host against the release **this desktop**
   expects, never against the version recorded at pairing time. A saved Host ID
   is validated first: an identity mismatch remains `HOST_AUTH_FAILED` and never
   authorizes automatic realignment. A stale descriptor can no longer mask a
   Host that is behind.
2. After `connection/initialize`, the live handshake capabilities are checked
   once per connection. A Host that advertises no workspace tools/files — or
   reports no capabilities at all and is therefore not knowable — fails closed
   with `HOST_VERSION_MISMATCH`, the same typed failure the UI already explains.
3. On `HOST_VERSION_MISMATCH`, the boot layer re-runs the **same verified SSH
   bootstrap** the pairing path uses, from the stored SSH descriptor and the
   encrypted login password, then adopts the forward it opened and reconnects
   with the refreshed record (new loopback URL, new device token, new Host ID).
   No new trust anchor, download path, or install script is introduced.
4. Automatic attempt receipts are persisted as non-secret Host registry metadata,
   keyed by the desktop release, so an app restart does not reboot a Host again
   after a successful realignment. A failed attempt cools down for ten minutes
   before another automatic try; an explicit user reconnect bypasses the
   throttle. This prevents an unreachable Host or unpublished release from
   repeatedly restarting a remote process on every launch or user action.
5. A Host that cannot be realigned is left alone: a direct URL pairing has no SSH
   descriptor, and a password descriptor whose stored secret is gone is never
   replayed. Both keep the existing mismatch message.
6. A realignment that does not help surfaces the **original** mismatch unchanged,
   and the host stays `action-required`. Automatic repair never hides the reason
   the user sees.
7. Credential, sandbox and ownership boundaries are unchanged: the secret is read
   only from the encrypted record, never returned to the renderer, never logged,
   and the remote artifact is still fetched against the published SHA-256.

## Trust and compatibility

No new trust decision. The desktop still installs only a release artifact that
matches its own version and the published digest, and the remote side still
verifies it before installing. A compromised release publisher or SSH account
remains out of scope, exactly as in ADR 0326.

The visible cost is deliberate: realigning a Host restarts its remote process, so
another client of that Host is briefly disconnected. This occurs only after a
version/capability mismatch, not ordinary connection failures. Once a release is
successfully realigned, its persisted marker prevents further automatic restarts
for that release; an explicit user reconnect remains an opt-in retry.

Record compatibility is additive: the refreshed record keeps its shape, and a
key-authenticated record keeps exactly the fields it had. No database migration,
no RACP protocol change, and no change to direct (non-SSH) pairings is involved.
A Host on a release that has not been published yet still fails and the user still
sees the upgrade message. Persisted receipts suppress restart loops (with a
cooldown after failures), but cannot create a missing release artifact.
Publishing a matching Desktop and Host release is the remaining step, and ADR
0326's note that published tags are immutable stands.

## Alternatives

- Manual "upgrade Host" button only: leaves the reported failure unfixed, because
  the user's next folder selection still fails until they act.
- Compare against the recorded descriptor version (status quo): a stale record
  makes the check wrong in both directions.
- Re-pair on every reconnect: churns credentials and restarts a remote process
  for ordinary connection failures. Realignment is triggered by a version
  mismatch only.
- Trust the version alone and skip the capability check: a same-version bundle
  without workspace services would connect and then fail every `workspace/*`
  call, which is what the user saw.

## Consequences and qualification

A desktop release now drags its paired Hosts forward on first use, without the
user re-adding them. Operators who must pin a Host's release can keep using a
direct URL pairing, which this decision never touches.

Qualification is limited to automated coverage: the boot-level tests in
`apps/desktop/test/remote-host-realign.test.mjs` exercise the decision table, the
record replacement, the failed-forward cleanup and the full stale-host path with
injected SSH transports. A real Linux SSH host is required for acceptance, and
the scenario is recorded in E2E-REMOTE-SSH-OPTIMIZATION; a macOS development host
cannot qualify it.
