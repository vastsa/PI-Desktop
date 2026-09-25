# ADR 0292: SSH bootstrap for remote hosts

- Status: Accepted for implementation
- Date: 2026-09-19
- Decision: D453
- Related: ADR 0205 (D373 / D374 / D375), ADR 0285 (D448), ADR 0286 (D449),
  `02-architecture/05-remote-agent-control.md` §5.2,
  `05-security/02-remote-control-security.md` §3.4,
  `06-delivery/07-remote-control-rollout.md` §2 R2b

## Context

ADR 0286 delivered the desktop-side R2a kernel and left the bootstrap explicitly
out of scope: "Every paired host today assumes the loopback URL already exists."
Reaching another machine meant the user installed `pi-host` there, started it,
opened `ssh -L` themselves, and pasted the resulting URL and a pairing token into
Settings.

R2's exit criteria do not accept that (rollout §2 R2b, security §3.4). The
desktop has to install and pair a host on a machine the user already reaches over
SSH, under two boundaries the security spec fixes: the desktop never uploads
executable bytes, and it never holds an SSH secret.

Three properties of the system as it stands shaped the design:

- `release.yml` publishes `pi-host-<version>-<platform>-<arch>.tar.gz` and its
  `.sha256` to the `v<version>` GitHub Release, and the bundle matrix is Linux
  x64 only.
- A paired host is a URL in `remote-hosts.json`, but a bootstrapped host has no
  stable URL: the local port of a forward is chosen per launch.
- `bootstrap/remote-hosts.ts` already owns every host's lifecycle, so the
  bootstrap plugs into that layer instead of beside it.

## Decision

The bootstrap is five modules under `apps/desktop/electron/main/remote/`, one
extended boot hook, and one new IPC channel.

1. **The system `ssh` client is the transport.** Shelling out to `ssh` beats
   linking an SSH library because the user's `~/.ssh/config`, agent, jump hosts,
   and `known_hosts` then apply unchanged, and the app never holds a secret to
   leak. `BatchMode=yes` is what keeps that honest: a host needing an interactive
   password or passphrase fails immediately with a typed error instead of hanging
   a modal behind an invisible prompt. The module always sets
   `StrictHostKeyChecking=accept-new`, `ConnectTimeout=15`, and
   `ExitOnForwardFailure=yes`.

2. **Pure release coordinates (`pi-host-release.ts`).** The artifact is resolved
   for the *remote* platform at the *desktop's* version, and the SHA-256 the
   release publishes is the trust anchor. `PUBLISHED_TARGETS` is the release
   matrix (`linux-x64` today), so any other target is refused with
   `HOST_BOOTSTRAP_FAILED` before a download starts rather than as a 404 halfway
   through one. URL derivation, `uname` parsing, checksum-file parsing,
   constant-work digest comparison, and the version-parity rule are all pure
   functions with no network and no SSH.

3. **One script runs remotely (`pi-host-bootstrap-script.ts`).** It downloads the
   pinned URL, verifies the digest, installs under `$HOME/.pi-desktop/pi-host`,
   (re)starts the host on loopback with `--pair`, and echoes `PI_HOST_READY` /
   `PI_HOST_PAIRING_TOKEN`. It runs under `umask 077`, so the single-use pairing
   token only ever exists in a work file inside the bootstrap directory and on
   the SSH channel's stdout — never a world-readable path, never a URL
   (security §3.4). Every failure exits non-zero after a
   `PI_HOST_BOOTSTRAP_FAILED <step>` line, so the desktop reports the step that
   failed instead of a bare exit code. Generating it is pure and every input is
   shell-quoted by `shellQuote`, which is what lets the tests execute the
   generated text for real.

4. **`ssh-transport.ts` is a port, not a dependency.** `exec` / `execWithInput` /
   `forward` / `dispose` let the orchestrator be tested end to end against a fake
   with no process spawned; `createSystemSshTransport` is the only implementation
   that spawns. `execWithInput` pipes the script into `sh -s`, so the script
   never survives an argv round trip and never lands in a remote file to clean
   up. Values that reach the `ssh` argv are refused by `assertSshArgument` when
   they are empty or start with `-`: passed as its own argv entry, a leading dash
   becomes an option (`-oProxyCommand=…`), not a destination.

5. **Forwards are durable and owned, not incidental (`ssh-tunnel.ts`).** The
   persisted record stores the SSH descriptor, not a URL; the manager reserves a
   loopback port, runs `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort>`, and
   derives `ws://127.0.0.1:<port>/v1/racp/ws` per launch, so a restart
   re-establishes the tunnel before connecting instead of dialling a stale port.
   The bootstrap's own forward is *adopted*, not closed and reopened, so pairing
   pays for exactly one tunnel. A forward counts as ready only once its local
   port accepts a connection, because a healthy `ssh -N -L` prints nothing.

6. **Version parity is checked before a forward exists.** The desktop's version
   is what gets downloaded — there is no version negotiation — and
   `PI_HOST_READY.version` must equal it (`v` prefix tolerated either way). A
   mismatch raises `HOST_VERSION_MISMATCH` (D375) before any forward exists, and
   the desktop tears down the SSH processes it spawned on the way out instead of
   leaving a half-connected host behind.

7. **The registry keeps a descriptor, not a URL.** `metadata.transport = "ssh"`
   plus `metadata.ssh` (host, optional port / user / identity file,
   `remotePort`, `version`). `remote-hosts.json` is user-editable, so the
   descriptor is re-validated on every read: a missing host or a `remotePort`
   outside 1..65535 degrades the record to "not an SSH host" instead of
   producing an `ssh` spawn with garbage arguments. Records written before this
   change carry no `transport` and read as `direct`.

8. **One IPC channel and one pairing exchange.**
   `pi-desktop/remoteHost/bootstrap` joins `list` / `pair` / `remove` and carries
   a host, never a credential. The `connection/pair` exchange was factored into
   `exchangePairingToken`, used by both the pasted-URL path and the bootstrap
   path, and it closes its throwaway connection on every path. `bootstrapHost`
   adopts the forward before persisting the record, because the device token only
   works over that forward.

## Invariants

- No SSH secret is stored, prompted for, or transmitted by the app. The only
  credentials the bootstrap touches are the ones the system `ssh` client
  resolves itself.
- No executable bytes travel over the SSH channel. The remote script downloads
  the bundle; the bytes the desktop sends are the script text on stdin.
- `pi-host` keeps binding loopback only. The desktop reaches it through a
  forward and never opens a listener of its own.
- The renderer stays transport-agnostic. `RemoteHostSummary.transport` is
  optional and rendered as a label; no renderer call branches on it.
- An empty registry stays a full no-op: nothing connects and no tunnel opens.
- A failed bootstrap leaves nothing running: its transport is disposed unless
  the caller adopts the forward, and an SSH host whose connect fails has its
  tunnel closed rather than left idle.

## Out of scope

Still open for R2b and later:

- **Terminal work-panel client (Stage 5)** and **reverse tool relay (Stage 6)**
  from ADR 0286. Both remain unbuilt.
- **Provider configuration over the SSH channel.** Spec §3.4 and §5.2 name it as
  part of the bootstrap step, but it needs host-side provider schema work and is
  not in this change, so a freshly bootstrapped host still fails `turn/start`
  closed with `MODEL_NOT_CONFIGURED` until a provider is configured on it.
  > **Delivered by ADR 0310 (D629).** `pi-host provider-import` now copies
  > providers over the SSH channel's stdin to an owner-only admin socket on the
  > running host, so a bootstrapped host can be made turn-ready from the desktop
  > without a manual login. The key never crosses argv, logs, or RACP.
- **The resync watchdog**: `resync.required` events are still dropped.
- **Non-Linux remote targets, and Windows as a *remote* target.** Only
  `linux-x64` is published, so both are refused before a download starts.

## Alternatives considered

- **An `ssh2`-style library instead of the system client.** Rejected: it
  re-implements config, agent, and jump-host semantics the user already has, and
  asks them to re-enter credentials the app should never hold.
- **Download the artifact on the desktop and upload it.** Rejected by security
  §3.4: the desktop never uploads executable bytes.
- **Let the script read the published `.sha256` itself.** Rejected: the desktop
  should hold the trust anchor, and this keeps the script's only input a URL plus
  a digest.
- **Store the forwarded URL in the registry.** Simpler read path, but the local
  port is not stable across launches, so a restart would dial a port nothing
  listens on. Rejected in favour of the descriptor.
- **Install the host into a user-level service manager.** Rejected: the script
  installs under `$HOME` and restarts the process its own pidfile tracks, which
  keeps the bootstrap privilege-free.

## Testing

The release rules and the script generator are pure and covered by `node --test`
fixtures; the generator's tests run `sh -n` over the produced text and execute it
against a stubbed `PATH`. The orchestrator runs end to end against a fake
transport, a fake checksum fetch, reserved ports, and a fake pairing exchange, so
step order, the digest failure path, the version-mismatch path with no forward,
and the adopt-don't-reopen rule are asserted without spawning a process.

## Consequences

- `remote-hosts.json` gains a second record shape and stays backward compatible:
  existing records have no `transport` and are read as `direct`.
- A machine without outbound GitHub access still cannot be bootstrapped (D375).
- The desktop now spawns `ssh` processes, which is new and visible to
  endpoint-security tooling; until now the remote stack only opened outbound
  WebSocket connections.
- The 16 new `settings.remoteHosts` i18n keys must be translated in every shipped
  locale, because the catalog type is exhaustive.
- No new runtime dependency: the bootstrap adds no SSH library, no HTTP client,
  and no archive tool to `apps/desktop`.
