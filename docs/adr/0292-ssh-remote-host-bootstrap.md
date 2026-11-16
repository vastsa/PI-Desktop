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
`download-failed`, bundles matching Node, and separates daily startup from pairing;
the constraints below remain context for that amendment.

## Context

ADR 0286 left bootstrap out of scope: every paired host assumed the loopback URL
already existed, so reaching another machine meant installing `pi-host` by hand,
opening `ssh -L`, and pasting the URL and pairing token into Settings. R2's exit
criteria do not accept that (rollout §2 R2b, security §3.4). The desktop must
install and pair a host on a machine the user already reaches over SSH while never
uploading executable bytes and never holding an SSH secret. Three properties shaped
the design: the release publishes `pi-host-<version>-<platform>-<arch>.tar.gz` with
a `.sha256` for Linux targets only; a bootstrapped host has no stable URL because the
forward's local port is chosen per launch; and `bootstrap/remote-hosts.ts` already
owns every host's lifecycle.

## Decision

1. **The system `ssh` client is the transport.** It keeps `~/.ssh/config`, the
   agent, jump hosts, and `known_hosts` in force and leaves the app holding no
   secret. `BatchMode=yes` fails an interactive-password host immediately with a
   typed error instead of hanging a hidden prompt, and `StrictHostKeyChecking=accept-new`,
   `ConnectTimeout=15`, and `ExitOnForwardFailure=yes` are always set.
2. **Pure release coordinates (`pi-host-release.ts`).** The artifact resolves for the
   *remote* platform at the *desktop's* version, and the published SHA-256 is the
   trust anchor. `PUBLISHED_TARGETS` (`linux-x64`, `linux-arm64`) refuses other
   targets with `HOST_BOOTSTRAP_FAILED` before a download. URL derivation, `uname`
   parsing, checksum parsing, digest comparison, and version parity are pure.
3. **One script runs remotely (`pi-host-bootstrap-script.ts`).** It downloads the
   pinned URL, verifies the digest, installs under `$HOME/.pi-desktop/pi-host`,
   (re)starts the host on loopback with `--pair`, and echoes `PI_HOST_READY` /
   `PI_HOST_PAIRING_TOKEN` under `umask 077`, so the single-use token exists only in
   a work file and on stdout. Failures exit non-zero after
   `PI_HOST_BOOTSTRAP_FAILED <step>`, and every input is quoted by `shellQuote`.
4. **`ssh-transport.ts` is a port, not a dependency.** `exec` / `execWithInput` /
   `forward` / `dispose` allow tests against a fake, with
   `createSystemSshTransport` the only spawning implementation. `execWithInput` pipes
   the script into `sh -s`, and `assertSshArgument` refuses empty values or those
   starting with `-`.
5. **Forwards are durable and owned (`ssh-tunnel.ts`).** The record stores the SSH
   descriptor, not a URL; the manager reserves a loopback port, runs
   `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort>`, and derives
   `ws://127.0.0.1:<port>/v1/racp/ws` per launch. The bootstrap's own forward is
   adopted rather than reopened, and a forward counts as ready only once its local
   port accepts a connection.
6. **Version parity is checked before a forward exists.** A `PI_HOST_READY.version`
   mismatch raises `HOST_VERSION_MISMATCH` (D375) and the desktop tears down the SSH
   processes it spawned.
7. **The registry keeps a descriptor**: `metadata.transport = "ssh"` plus
   `metadata.ssh` (host, optional port / user / identity file, `remotePort`,
   `version`). Because `remote-hosts.json` is user-editable it is re-validated on
   every read, degrading to "not an SSH host" rather than spawning `ssh` with
   garbage, and records without `transport` read as `direct`.
8. **One IPC channel and one pairing exchange.**
   `pi-desktop/remoteHost/bootstrap` joins `list` / `pair` / `remove` and carries a
   host, never a credential. `connection/pair` was factored into
   `exchangePairingToken`, shared with the pasted-URL path and closing its throwaway
   connection on every path; `bootstrapHost` adopts the forward before persisting the
   record.

## Consequences

- No SSH secret is stored, prompted for, or transmitted, and no executable bytes
  travel over the channel: the remote script downloads the bundle and the desktop
  sends only script text on stdin. `pi-host` keeps binding loopback only, and the
  renderer stays transport-agnostic with `RemoteHostSummary.transport` as a label.
- `remote-hosts.json` gains a second record shape and stays backward compatible. The
  desktop now spawns `ssh` processes, visible to endpoint-security tooling, and the
  new `settings.remoteHosts` i18n keys must be translated in every shipped locale.
  No SSH library, HTTP client, or archive tool enters `apps/desktop`.
- A failed bootstrap leaves nothing running, an empty registry is a no-op, and a
  machine without outbound GitHub access still cannot be bootstrapped (D375).

## Out of scope

- **Terminal work-panel client (Stage 5)** and **reverse tool relay (Stage 6)**
  remain unbuilt, and `resync.required` events are still dropped.
- **Provider configuration over SSH** needs host-side schema work, so a freshly
  bootstrapped host still fails `turn/start` closed with `MODEL_NOT_CONFIGURED`.
- **Non-Linux remote targets** are refused before a download starts, since only
  `linux-x64` and `linux-arm64` are published (D638 / ADR 0318).

## Alternatives

- An `ssh2`-style library: re-implements config, agent, and jump-host semantics and
  asks users to re-enter credentials the app should never hold.
- Download on the desktop and upload: rejected by security §3.4.
- Let the script read the published `.sha256`: the desktop holds the trust anchor.
- Store the forwarded URL: the local port is not stable across launches.
- Install into a user-level service manager: `$HOME` plus a pidfile stays
  privilege-free.
