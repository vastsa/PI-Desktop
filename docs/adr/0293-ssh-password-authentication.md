# ADR 0293: SSH password authentication for the remote-host bootstrap

- Status: Accepted
- Date: 2026-09-19
- Decision: D454
- Amends: [ADR 0292](0292-ssh-remote-host-bootstrap.md) — its "no SSH secret is
- Related: [ADR 0286](0286-remote-host-desktop-kernel.md) (D449), ADR 0205 (D373),
  `02-architecture/05-remote-agent-control.md` §5.2,
  `05-security/02-remote-control-security.md` §3.4

## Context

ADR 0292 bootstraps a `pi-host` on a machine the user already reaches over SSH
by shelling out to the system `ssh` client. That choice was made deliberately
and its main argument was that the app holds no SSH secret at all:
`~/.ssh/config`, the agent, and `known_hosts` decide the login, so there is
nothing for the app to leak.

- The transport spawns `ssh` with no terminal, so a password cannot simply be
  handed over; OpenSSH must be given a way to ask for one.
- A secret that must survive a restart to keep reconnecting is a secret at rest,
  and the app already has exactly one encrypted-at-rest store it trusts.
- The transport is a port (`SshTransport`) with the bootstrap and the tunnel
  manager on the other side of it, so whatever carries the secret has to be
  expressible through that seam.

## Decision

1. **Password auth is opt-in, and a key or agent stays the default.** Absent
   credentials, the argv is byte-for-byte what ADR 0292 produced,
   `BatchMode=yes` included.

2. **The secret reaches `ssh` through OpenSSH's own askpass helper**
   (`remote/ssh-askpass.ts`).

3. **`BatchMode=yes` becomes `BatchMode=no` only when a password is supplied,
   together with `NumberOfPasswordPrompts=1` and `PubkeyAuthentication=no`.**
   The helper answers every prompt with the same secret, so a retry could only
   repeat a wrong password, and repeated failures are what trip a server's own
   lockout.

4. **The credential is short-lived.** Material is written when a child is about
   to authenticate and deleted once it cannot still be prompting: after an
   `exec` / `execWithInput` child has closed, after a forward's local port is
   up, or on `dispose`.

5. **The password is persisted encrypted, in a new record field.**
   `RemoteHostRecord.sshSecret` is written to `remote-hosts.json` as
   `encryptedSshSecret` through the same `safeStorage`-backed `EncryptionPort`
   the device token already uses, and read back the same way.

6. **The secret never reaches the renderer.** `RemoteHostSshMetadata` stays
   secret-free by construction: it is plaintext metadata, it is stored in
   `metadata`, and it is echoed to the renderer inside
   `RemoteHostBootstrapResult`.

7. **A password that cannot work is refused before anything runs.** A line break
   cannot survive the askpass round trip, so `assertSshPassword` rejects one
   with `INVALID_ARGUMENT` in the bootstrap rather than letting it become a
   failed authentication.

8. **The Settings surface says what it does.** The SSH form gains an
   authentication mode with a masked password field and a reveal toggle, and its
   description states that the login password is saved in the OS keychain so the
   host reconnects after a restart.

## Invariants

- With no password supplied, nothing changes: same argv, same `BatchMode=yes`,
  no credential file created, no askpass variables set.
- The password is never an `ssh` argument, never an environment variable value,
  never in a URL, never in a log line, and never in a renderer payload.
- Credential files exist only inside a `0700` directory, only for the interval
  in which an `ssh` child can still prompt, and are removed on every path —
  including `dispose` and a failed `forward`.
- Nothing but the system `ssh` client consumes the secret; no library, no second
  credential store, and no keychain entry of its own.
- A malformed or absent descriptor still degrades to "not an SSH host" rather
  than to a spawn with junk arguments.

## Out of scope

- **Interactive (non-persisted) prompting.** The password is supplied once by
  the user in Settings and either remembered encrypted or not at all; there is
  no "ask me each time" mode, which would need a main-process prompt surface.
- **Keyboard-interactive auth as a separate mode.** `ssh` treats it as the same
  prompt, so the helper answers both with one secret and there is no second
  switch to expose.
- **Windows support**, as above, and **non-Linux remote targets**, unchanged
  from ADR 0292.
- **Key passphrase storage.** A passphrase unlocks a local key; the askpass
  helper answers that prompt only as a side effect of the same secret being
  supplied for the login.

## Alternatives considered

- **`sshpass`, or `SSH_ASKPASS` with the secret in the environment.** Rejected:
  `sshpass` is a third-party dependency that must be installed, and either form
  exposes the secret to anything that can read the process environment or
  arguments — including other users on a shared machine.
- **A PTY and a scripted `expect`-style dialog.** Rejected: it reintroduces a
  pseudo-terminal whose prompts and timing the desktop would have to parse, and
  it makes an interactive prompt possible again on a path that was designed to
  fail closed.
- **Store the password unencrypted in `metadata`.** Rejected: `metadata` is
  plaintext, is user-editable, and is not covered by the keychain, so it would
  put a reusable credential into a file the app cannot protect.
- **Keep nothing at rest and ask on every launch.** Rejected for now: it would
  make an SSH host the only paired host that needs a human at startup, so a
  restart would silently leave it offline.

## Consequences

- The desktop can now be asked to hold an SSH password, which is a real widening
  of what the app is trusted with.
- `remote-hosts.json` gains an optional `encryptedSshSecret` and
  `metadata.ssh.auth`.
- Users can now bootstrap a host whose only credential is a password, which
  removes the terminal detour that ADR 0292's `BatchMode=yes` left in place.
- Server-side lockout policy becomes reachable through the app: one wrong saved
  password produces one failed attempt per connect.
- The `settings.remoteHosts` copy that claimed no password is ever stored had to
  change in eight locales, and the claim in ADR 0292 needed an explicit
  amendment rather than a quiet edit.
