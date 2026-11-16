# ADR 0292: SSH bootstrap for remote hosts

- Status: Accepted for implementation
- Date: 2026-09-19
- Decision: D453
- Related: ADR 0205 (D373 / D374 / D375), ADR 0285 (D448), ADR 0286 (D449),
  `02-architecture/05-remote-agent-control.md` §5.2,
  `05-security/02-remote-control-security.md` §3.4,
  `06-delivery/07-remote-control-rollout.md` §2 R2b
- Amendments: [ADR 0293](0293-ssh-password-authentication.md) permits secure SSH password handling; [ADR 0326](0326-verified-ssh-host-installation.md) supersedes the executable-upload prohibition, remote-only download prerequisite and daily bootstrap lifecycle below.

This record describes the original bootstrap decision, not the current candidate
installation contract. ADR 0326 permits a verified release upload only after
`download-failed`, bundles matching Node, and separates daily startup from pairing.
The historical constraints and alternatives below remain context for that amendment.

## Context

ADR 0286 delivered the desktop-side R2a kernel and left the bootstrap explicitly
out of scope: "Every paired host today assumes the loopback URL already exists."
Reaching another machine meant the user installed `pi-host` there, started it,
opened `ssh -L` themselves, and pasted the resulting URL and a pairing token
into Settings.

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
   leak.

2. **Pure release coordinates (`pi-host-release.ts`).** The artifact is resolved
   for the *remote* platform at the *desktop's* version, and the SHA-256 the
   release publishes is the trust anchor.

3. **One script runs remotely (`pi-host-bootstrap-script.ts`).** It downloads
   the pinned URL, verifies the digest, installs under
   `$HOME/.pi-desktop/pi-host`, (re)starts the host on loopback with `--pair`,
   and echoes `PI_HOST_READY` / `PI_HOST_PAIRING_TOKEN`.

4. **`ssh-transport.ts` is a port, not a dependency.** `exec` / `execWithInput`
   / `forward` / `dispose` let the orchestrator be tested end to end against a
   fake with no process spawned; `createSystemSshTransport` is the only
   implementation that spawns.

5. **Forwards are durable and owned, not incidental (`ssh-tunnel.ts`).** The
   persisted record stores the SSH descriptor, not a URL; the manager reserves a
   loopback port, runs `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort>`, and
   derives `ws://127.0.0.1:<port>/v1/racp/ws` per launch, so a restart
   re-establishes the tunnel before connecting instead of dialling a stale port.

6. **Version parity is checked before a forward exists.** The desktop's version
   is what gets downloaded — there is no version negotiation — and
   `PI_HOST_READY.version` must equal it (`v` prefix tolerated either way).

7. **The registry keeps a descriptor, not a URL.** `metadata.transport = "ssh"`
   plus `metadata.ssh` (host, optional port / user / identity file,
   `remotePort`, `version`).

8. **One IPC channel and one pairing exchange.**
   `pi-desktop/remoteHost/bootstrap` joins `list` / `pair` / `remove` and
   carries a host, never a credential.

## Invariants

- No SSH secret is stored, prompted for, or transmitted by the app.
- No executable bytes travel over the SSH channel.
- `pi-host` keeps binding loopback only.
- The renderer stays transport-agnostic.
- An empty registry stays a full no-op: nothing connects and no tunnel opens.
- A failed bootstrap leaves nothing running: its transport is disposed unless
  the caller adopts the forward, and an SSH host whose connect fails has its
  tunnel closed rather than left idle.

## Out of scope

Still open for R2b and later:

- **Terminal work-panel client (Stage 5)** and **reverse tool relay (Stage 6)**
  from ADR 0286.
- **Provider configuration over the SSH channel.** Spec §3.4 and §5.2 name it as
  part of the bootstrap step, but it needs host-side provider schema work and is
  not in this change, so a freshly bootstrapped host still fails `turn/start`
  closed with `MODEL_NOT_CONFIGURED` until a provider is configured on it.
- **The resync watchdog**: `resync.required` events are still dropped.
- **Non-Linux remote targets, and Windows as a *remote* target.** Only
  `linux-x64` and `linux-arm64` are published (D638 / ADR 0318), so both are
  refused before a download starts.

## Alternatives considered

- **An `ssh2`-style library instead of the system client.** Rejected: it
  re-implements config, agent, and jump-host semantics the user already has, and
  asks them to re-enter credentials the app should never hold.
- **Download the artifact on the desktop and upload it.** Rejected by security
  §3.4: the desktop never uploads executable bytes.
- **Let the script read the published `.sha256` itself.** Rejected: the desktop
  should hold the trust anchor, and this keeps the script's only input a URL
  plus a digest.
- **Store the forwarded URL in the registry.** Simpler read path, but the local
  port is not stable across launches, so a restart would dial a port nothing
  listens on.

## Consequences

- `remote-hosts.json` gains a second record shape and stays backward compatible:
  existing records have no `transport` and are read as `direct`.
- A machine without outbound GitHub access still cannot be bootstrapped (D375).
- The desktop now spawns `ssh` processes, which is new and visible to
  endpoint-security tooling; until now the remote stack only opened outbound
  WebSocket connections.
- The 16 new `settings.remoteHosts` i18n keys must be translated in every
  shipped locale, because the catalog type is exhaustive.
- No new runtime dependency: the bootstrap adds no SSH library, no HTTP client,
  and no archive tool to `apps/desktop`.
