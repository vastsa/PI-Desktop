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

1. The probe compared the running Host against the version **recorded when the
   host was paired**, not against the desktop release.
2. Nothing in the product could upgrade a paired Host.

## Decision

1. Readiness compares the running Host against the release **this desktop**
   expects, never against the version recorded at pairing time.
2. After `connection/initialize`, the live handshake capabilities are checked
   once per connection.
3. On `HOST_VERSION_MISMATCH`, the boot layer re-runs the **same verified SSH
   bootstrap** the pairing path uses, from the stored SSH descriptor and the
   encrypted login password, then adopts the forward it opened and reconnects
   with the refreshed record (new loopback URL, new device token, new Host ID).
4. Automatic attempt receipts are persisted as non-secret Host registry
   metadata, keyed by the desktop release, so an app restart does not reboot a
   Host again after a successful realignment.
5. A Host that cannot be realigned is left alone: a direct URL pairing has no
   SSH descriptor, and a password descriptor whose stored secret is gone is
   never replayed.
6. A realignment that does not help surfaces the **original** mismatch
   unchanged, and the host stays `action-required`.
7. Credential, sandbox and ownership boundaries are unchanged: the secret is
   read only from the encrypted record, never returned to the renderer, never
   logged, and the remote artifact is still fetched against the published
   SHA-256.

## Trust and compatibility

No new trust decision. The desktop still installs only a release artifact that
matches its own version and the published digest, and the remote side still
verifies it before installing.

The visible cost is deliberate: realigning a Host restarts its remote process,
so another client of that Host is briefly disconnected. This occurs only after a
version/capability mismatch, not ordinary connection failures.

## Alternatives

- Manual "upgrade Host" button only: leaves the reported failure unfixed,
  because the user's next folder selection still fails until they act.
- Compare against the recorded descriptor version (status quo): a stale record
  makes the check wrong in both directions.
- Re-pair on every reconnect: churns credentials and restarts a remote process
  for ordinary connection failures.
- Trust the version alone and skip the capability check: a same-version bundle
  without workspace services would connect and then fail every `workspace/*`
  call, which is what the user saw.

## Consequences and qualification

A desktop release now drags its paired Hosts forward on first use, without the
user re-adding them.

Qualification is limited to automated coverage: the boot-level tests in
`apps/desktop/test/remote-host-realign.test.mjs` exercise the decision table,
the record replacement, the failed-forward cleanup and the full stale-host path
with injected SSH transports.
