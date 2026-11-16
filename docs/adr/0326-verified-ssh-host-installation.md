# ADR 0326: Verified SSH Host installation and daily startup

- Status: Accepted for experimental implementation; Linux SSH qualification and release publication pending
- Date: 2026-10-11
- Related: [ADR 0292](0292-ssh-remote-host-bootstrap.md), [ADR 0293](0293-ssh-password-authentication.md), [Local Agent remote workspace tools](local-agent-remote-workspace-tools.md)
- Amends: [ADR 0292](0292-ssh-remote-host-bootstrap.md), specifically the executable-upload prohibition and the remote GitHub-access prerequisite, plus the corresponding D375 deployment choice

## Context

The original bootstrap required system Node 22 or newer and outbound GitHub access
on the remote machine, and reusing installation and pairing for daily connection
risks unnecessary downloads, process restarts, and credential churn. Users already
hold SSH shell authority, so a blanket ban on executable upload blocked a useful
fallback without protecting against a compromised release source.

## Decision

1. Keep system OpenSSH with its host-key checks, configured identities and jump
   hosts, and RACP-WS over loopback forwarding. No SSH stdio RPC, public listener,
   elevated privileges, or mandatory systemd service.
2. Resolve the matching Desktop version and published Linux x64 or arm64 target,
   and take the named archive SHA-256 from the trusted GitHub Release. A remote
   download is preferred; only an explicit `download-failed` permits one bounded
   Desktop download and SSH stdin upload of the same archive, while integrity,
   authentication, and version failures never authorize that fallback.
3. Verify the archive before extraction on the remote machine, and verify the
   fallback locally before uploading it under a bounded size and time limit, using
   private temporary directories with cleanup on success and failure.
4. Bundle native-target Node 22 or newer, the Agent runtime, host-core, launcher,
   installer, and `SHA256SUMS`. Staged files are verified, unsafe manifest paths
   rejected, version directories installed content-addressed, and the `current`
   symlink replaced atomically under kernel-owned locks. A failed stage never
   overwrites the previous install, and a legacy real `current` directory is
   refused rather than converted.
5. Bootstrap reuse requires an external `.release.sha256` receipt matching the
   version, trusted archive digest, and installed manifest digest, plus a
   successful read-only `install.sh --verify`. Bundles without a manifest do not
   qualify.
6. Install and pairing are separate from daily readiness: the supervisor starts the
   installed Host only when needed, prefers bundled Node, uses `--port 0` without
   `--pair`, preserves Host identity and device credentials, validates loopback
   readiness, version, and the saved Host id before forwarding, and revalidates the
   RACP identity on reconnect. An ordinary disconnect does not kill a Host another
   client may use.
7. New remote workspace projects keep Agent execution, models, credentials,
   permissions, and sessions on Desktop; remote tools, files, and root repository
   instructions use owner-only workspace services.
8. Recovery never replays `Write`, `Edit`, or `Bash`. A lost transport reply yields
   the non-retriable `REMOTE_MUTATION_OUTCOME_UNKNOWN` and requires inspection
   before an explicit retry.

## Consequences

- SHA-256 authenticates bytes against the trusted release descriptor but is not a
  signature, so host authentication and workspace containment stay mandatory.
- No migration appears, existing connections keep ownership, and legacy Host
  installations may need an explicit reinstall to gain the bundled runtime.
- Desktop may now send verified release bytes through the user's SSH session: a
  limited amendment to ADR 0292, not permission to upload arbitrary
  model-generated executables.
- The change stays Experimental; Linux kernel-lock crash recovery, fresh
  installation, and reboot recovery are gated by E2E-REMOTE-SSH-OPTIMIZATION.
