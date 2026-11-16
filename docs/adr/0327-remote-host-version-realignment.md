# ADR 0327: Automatic remote Host version realignment

- Status: Accepted for experimental implementation (amends ADR 0326 item 6: daily startup is still not an installer, but a version mismatch is now repaired instead of only reported)
- Date: 2026-10-12
- Related: [ADR 0326](0326-verified-ssh-host-installation.md), [ADR 0292](0292-ssh-remote-host-bootstrap.md), [ADR 0293](0293-ssh-password-authentication.md), [architecture §5.2](../spec/02-architecture/05-remote-agent-control.md#52-remote-host-over-an-ssh-tunnel-first-remote-topology), [security §3.4](../spec/05-security/02-remote-control-security.md#34-ssh-bootstrap-pairing-first-remote-topology)

## Context

A paired Host is pinned to the desktop release that installed it, but the readiness
probe compared the running Host against the version recorded at pairing time
instead of the release this desktop expects, so the refusal was wrong in both
directions. Nothing in the product could upgrade a paired Host either: the only
remedy was to remove and re-pair, discarding a working SSH descriptor and its
encrypted credential, which left the reported upgrade toast with no action behind
it. A same-version bundle can also predate an additive capability, observable only
in the RACP handshake.

## Decision

1. Readiness compares the running Host against the release this desktop expects,
   never against the pairing-time record, and a saved Host ID is validated first,
   with an identity mismatch staying `HOST_AUTH_FAILED` and never authorizing
   automatic realignment.
2. After `connection/initialize`, live handshake capabilities are checked once per
   connection; a Host that advertises no workspace tools and files, or reports no
   capabilities at all, fails closed with `HOST_VERSION_MISMATCH`.
3. On that failure the boot layer re-runs the same verified SSH bootstrap the
   pairing path uses, from the stored descriptor and encrypted login password,
   adopts the forward it opened, and reconnects with the refreshed record. No new
   trust anchor, download path, or install script is introduced.
4. Automatic attempt receipts persist as non-secret Host registry metadata keyed by
   the desktop release, so a restart does not reboot a realigned Host, and a failed
   attempt cools down before another automatic try while an explicit reconnect
   bypasses the throttle.
5. A Host that cannot be realigned is left alone, because a direct URL pairing has
   no SSH descriptor and a descriptor whose stored secret is gone is never
   replayed.
6. A realignment that does not help surfaces the original mismatch unchanged and
   leaves the host action-required.
7. Credential, sandbox, and ownership boundaries are unchanged: the secret is read
   only from the encrypted record, never returned to the renderer, never logged,
   and the remote artifact is still verified against the published SHA-256.

## Consequences

- A desktop release drags its paired Hosts forward on first use without the user
  re-adding them, while operators that must pin a release can keep using direct URL
  pairing.
- Realignment restarts the remote process and briefly disconnects other clients of
  that Host, and only a version or capability mismatch triggers it.
- Record compatibility is additive with no database migration and no RACP change,
  and a release that is not published yet still fails with the upgrade message.

## Alternatives

- Manual "upgrade Host" button only: rejected, the reported failure stays until the
  user acts.
- Re-pair on every reconnect: rejected, it churns credentials and restarts a remote
  process for ordinary connection failures.
- Trust the version and skip the capability check: rejected, a same-version bundle
  without workspace services would fail every `workspace/*` call.
