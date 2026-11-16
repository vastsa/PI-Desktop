# ADR 0293: SSH password authentication for the remote-host bootstrap

- Status: Accepted (D454; amends [ADR 0292](0292-ssh-remote-host-bootstrap.md), whose
  no-SSH-secret clause is narrowed to the default key/agent path)
- Date: 2026-09-19
- Related: D373, D449, D454, ADR 0205, ADR 0286, ADR 0292

## Context

ADR 0292 bootstraps a `pi-host` by shelling out to the system `ssh` client with
`BatchMode=yes` enforcing that the app holds no SSH secret, but that does not cover a
fresh cloud instance, NAS, or container host reachable from a terminal after one
password prompt — the user would have to install a key first, which is the detour the
bootstrap exists to remove. Accepting a password means the app holds a secret, so the
decision is what shape that takes.

## Decision

1. Password auth is opt-in and a key or agent stays the default: absent credentials the
   argv is byte-for-byte what ADR 0292 produced, `BatchMode=yes` included.
2. The secret reaches `ssh` through OpenSSH's own askpass helper
   (`remote/ssh-askpass.ts`): `SSH_ASKPASS` names a generated `/bin/sh` script and
   `SSH_ASKPASS_REQUIRE=force` makes `ssh` use it without a terminal, with the script
   reading the secret from a `0600` file in a `0700` `mkdtemp` directory, so the secret
   is never an `ssh` argument or environment value.
3. Password mode alone sets `BatchMode=no` with `NumberOfPasswordPrompts=1` and
   `PubkeyAuthentication=no`: the helper answers every prompt with the same secret, so a
   retry could only repeat a wrong password and trip a server lockout.
4. The credential is short-lived: material is written just before a child authenticates
   and deleted once it cannot still be prompting — after an `exec` / `execWithInput`
   child closes, after a forward's local port is up, or on `dispose` — with a reference
   count keeping a shared copy alive across concurrent children.
5. The password is persisted encrypted: `RemoteHostRecord.sshSecret` is written as
   `encryptedSshSecret` through the same `safeStorage`-backed `EncryptionPort` the device
   token uses, and `metadata.ssh` gains `auth: "password"` as its only new value, so key
   descriptors and earlier records keep their shape.
6. The secret never reaches the renderer: `RemoteHostSshMetadata` stays secret-free by
   construction, the password travels beside it from the IPC request into
   `SshTarget.password` and back out as `SshBootstrapOutcome.sshSecret` for the caller to
   encrypt, and `RemoteHostSummary` is unchanged.
7. A password that cannot work is refused before anything runs: `assertSshPassword`
   rejects a line break with `INVALID_ARGUMENT` because it cannot survive the askpass
   round trip, Windows is refused with `HOST_BOOTSTRAP_FAILED` naming the remedy, and a
   host recorded as `auth: "password"` without a usable secret reports as disconnected
   rather than as a rejected login.
8. The Settings SSH form gains an authentication mode with a masked password field and
   reveal toggle, states that the password is saved in the OS keychain so the host
   reconnects after a restart, and the copy promising no password was ever stored is
   replaced in all shipped locales.

## Consequences

- The desktop can now be trusted with an SSH password — a real widening, bounded by being
  opt-in per host, encrypted with the existing store, and never exposed to the renderer,
  the process table, a URL, or a log line.
- `remote-hosts.json` gains an optional `encryptedSshSecret` and `metadata.ssh.auth`; both
  are additive and the file version stays `1`.
- A host whose only credential is a password can be bootstrapped, removing the terminal
  detour; nothing but the system `ssh` client consumes the secret, and a malformed
  descriptor degrades to "not an SSH host".

## Alternatives

- `sshpass` or `SSH_ASKPASS` with the secret in the environment: a third-party dependency
  that exposes the secret to anything reading process state.
- Store the password unencrypted in `metadata`: plaintext, user-editable, and outside the
  keychain.
