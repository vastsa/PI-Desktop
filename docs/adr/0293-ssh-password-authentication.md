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
nothing for the app to leak. `BatchMode=yes` enforced the claim — a host that
needed an interactive password failed immediately with a typed error instead of
hanging behind an invisible prompt.

That is the right default and it stays. It is not, however, sufficient for the
machines this feature exists for. A fresh cloud instance, a NAS, a container
host, or any box provisioned with a password and no key yet is reachable from a
terminal after one `ssh` prompt, while the desktop refuses it. The user's only
recourse is to install a key from a terminal first — which is exactly the
"use your terminal instead" detour the bootstrap was built to remove.

There is no way to support that case while keeping the invariant literally
true. Accepting a password means the app holds a secret, so the decision is
what shape that takes, not whether it exists. Three constraints bound the
answer:

- The transport spawns `ssh` with no terminal, so a password cannot simply be
  handed over; OpenSSH must be given a way to ask for one.
- A secret that must survive a restart to keep reconnecting is a secret at rest,
  and the app already has exactly one encrypted-at-rest store it trusts.
- The transport is a port (`SshTransport`) with the bootstrap and the tunnel
  manager on the other side of it, so whatever carries the secret has to be
  expressible through that seam.

## Decision

1. **Password auth is opt-in, and a key or agent stays the default.** Absent
   credentials, the argv is byte-for-byte what ADR 0292 produced, `BatchMode=yes`
   included. A target that carries a password is the only one that differs.

2. **The secret reaches `ssh` through OpenSSH's own askpass helper**
   (`remote/ssh-askpass.ts`). `SSH_ASKPASS` names a generated `/bin/sh` script
   and `SSH_ASKPASS_REQUIRE=force` makes `ssh` use it without a terminal; the
   script `cat`s the secret from a file and terminates the line, because
   `ssh` reads the helper's answer only up to the first line break. The secret
   is therefore never an `ssh` argument and never an environment variable — it
   is a path in the environment and bytes in a file, so `ps` output and argv
   dumps stay clean. Its confidentiality rests on modes rather than convention:
   a `0700` directory created by `mkdtemp`, a `0600` secret, a `0700` helper.

3. **`BatchMode=yes` becomes `BatchMode=no` only when a password is supplied,
   together with `NumberOfPasswordPrompts=1` and `PubkeyAuthentication=no`.**
   The helper answers every prompt with the same secret, so a retry could only
   repeat a wrong password, and repeated failures are what trip a server's own
   lockout. One prompt, one answer. Default identities are skipped: an encrypted
   `~/.ssh/id_rsa` would consume that single prompt as a key passphrase and the
   login password would never be tried. Password mode in Settings replaces a
   key; a user with both picks key mode.

4. **The credential is short-lived.** Material is written when a child is about
   to authenticate and deleted once it cannot still be prompting: after an
   `exec` / `execWithInput` child has closed, after a forward's local port is
   up, or on `dispose`. A reference count keeps a shared copy alive across
   concurrent children and drops it when the last one is done, so the ordinary
   case leaves one file on disk for the duration of one authentication and
   nothing afterwards.

5. **The password is persisted encrypted, in a new record field.**
   `RemoteHostRecord.sshSecret` is written to `remote-hosts.json` as
   `encryptedSshSecret` through the same `safeStorage`-backed `EncryptionPort`
   the device token already uses, and read back the same way. The descriptor in
   `metadata.ssh` gains `auth: "password"` — and only that value is written, so
   a key descriptor and every record written before this change keep exactly the
   shape they had. A record whose SSH password will not decrypt (keychain moved,
   different OS user) loses the secret but keeps the paired host, because the
   device token is independent of it.

6. **The secret never reaches the renderer.** `RemoteHostSshMetadata` stays
   secret-free by construction: it is plaintext metadata, it is stored in
   `metadata`, and it is echoed to the renderer inside
   `RemoteHostBootstrapResult`. The password travels beside it — from the IPC
   request into `SshTarget.password`, and back out of the bootstrap as
   `SshBootstrapOutcome.sshSecret` for the caller to encrypt — and
   `RemoteHostSummary` is unchanged.

7. **A password that cannot work is refused before anything runs.** A line break
   cannot survive the askpass round trip, so `assertSshPassword` rejects one with
   `INVALID_ARGUMENT` in the bootstrap rather than letting it become a failed
   authentication. Windows is refused with `HOST_BOOTSTRAP_FAILED` naming the
   remedy, because Windows OpenSSH cannot execute a shell-script askpass helper
   and shipping a helper executable is a project of its own. A host recorded as
   `auth: "password"` with no usable secret is not opened at all, which is
   reported as the host being disconnected instead of as a rejected login.

8. **The Settings surface says what it does.** The SSH form gains an
   authentication mode with a masked password field and a reveal toggle, and its
   description states that the login password is saved in the OS keychain so the
   host reconnects after a restart. The copy that promised no password was ever
   stored is replaced in all eight shipped locales.

## Invariants

- With no password supplied, nothing changes: same argv, same
  `BatchMode=yes`, no credential file created, no askpass variables set.
- The password is never an `ssh` argument, never an environment variable value,
  never in a URL, never in a log line, and never in a renderer payload.
- Credential files exist only inside a `0700` directory, only for the interval
  in which an `ssh` child can still prompt, and are removed on every path —
  including `dispose` and a failed `forward`.
- Nothing but the system `ssh` client consumes the secret; no library,
  no second credential store, and no keychain entry of its own.
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

- **`sshpass`, or `SSH_ASKPASS` with the secret in the environment.**
  Rejected: `sshpass` is a third-party dependency that must be installed, and
  either form exposes the secret to anything that can read the process
  environment or arguments — including other users on a shared machine.
- **A PTY and a scripted `expect`-style dialog.** Rejected: it reintroduces a
  pseudo-terminal whose prompts and timing the desktop would have to parse, and
  it makes an interactive prompt possible again on a path that was designed to
  fail closed.
- **Store the password unencrypted in `metadata`.** Rejected: `metadata` is
  plaintext, is user-editable, and is not covered by the keychain, so it would
  put a reusable credential into a file the app cannot protect.
- **Keep nothing at rest and ask on every launch.** Rejected for now: it would
  make an SSH host the only paired host that needs a human at startup, so a
  restart would silently leave it offline. Encrypting it in the same store as
  the device token keeps one credential model instead of two.
- **`ssh -o PreferredAuthentications=password`.** Rejected as a *key-path*
  default: forcing the method would turn a working agent login into a failure.
  Password mode (a secret supplied) instead sets `PubkeyAuthentication=no`,
  which is the exclusive Settings choice rather than a fall-through.

## Testing

`apps/desktop/test/remote-host-ssh-password.test.mjs` drives the whole path with
fixture executables and a fake `EncryptionPort`, so nothing touches a network or
a real keychain. It asserts the argv of a password spawn carries no secret and
the argv of a key spawn is unchanged, that the helper answers exactly what the
secret file holds, that the file, the helper, and their directory carry
`0600` / `0700` / `0700`, that material is gone once its child is done and after
`dispose`, that a round trip through the registry leaves no cleartext in
`remote-hosts.json`, and that a pre-existing key record reads back with no added
field.

## Consequences

- The desktop can now be asked to hold an SSH password, which is a real widening
  of what the app is trusted with. It is bounded by being opt-in per host,
  encrypted at rest through the store that already exists, and never exposed to
  the renderer or the process table.
- `remote-hosts.json` gains an optional `encryptedSshSecret` and
  `metadata.ssh.auth`. Both are additive: the file's `version` stays `1`, and a
  key-authenticated record is written exactly as before.
- Users can now bootstrap a host whose only credential is a password, which
  removes the terminal detour that ADR 0292's `BatchMode=yes` left in place.
- Server-side lockout policy becomes reachable through the app: one wrong saved
  password produces one failed attempt per connect. `NumberOfPasswordPrompts=1`
  keeps that to the minimum the user asked for.
- The `settings.remoteHosts` copy that claimed no password is ever stored had to
  change in eight locales, and the claim in ADR 0292 needed an explicit
  amendment rather than a quiet edit.
