# ADR 0326: Verified SSH Host installation and daily startup

- Status: Accepted for experimental implementation; Linux SSH qualification and release publication pending
- Date: 2026-10-11
- Deciders: PI-Desktop maintainers (user-authorized Remote SSH optimization plan)
- Amends: [ADR 0292](0292-ssh-remote-host-bootstrap.md), specifically the executable-upload prohibition and remote GitHub-access prerequisite; the corresponding D375 deployment choice
- Related: [ADR 0293](0293-ssh-password-authentication.md), [Local Agent remote workspace tools](local-agent-remote-workspace-tools.md), [architecture §5.2](../spec/02-architecture/05-remote-agent-control.md#52-remote-host-over-an-ssh-tunnel-first-remote-topology), [security §3.4](../spec/05-security/02-remote-control-security.md#34-ssh-bootstrap-pairing-first-remote-topology)

## Context

The original bootstrap required system Node 22+ and outbound GitHub access on
the remote machine. Reusing installation/pairing for daily connection also risks
unnecessary downloads, process restarts and credential churn. Users already have
SSH shell authority; a blanket prohibition on executable upload prevents a useful
fallback without protecting against a compromised release source.

## Decision

1. Keep system OpenSSH, its host-key checks, configured identities/agent/jump
   hosts, and RACP-WS over loopback forwarding. Do not introduce SSH stdio RPC,
   a public listener, elevated privileges or a mandatory systemd service.
2. Resolve the matching Desktop version and published Linux x64/arm64 target.
   Obtain the named archive SHA-256 from the trusted GitHub Release over HTTPS.
   Prefer a remote download. Only an explicit `download-failed` permits one
   bounded Desktop download and SSH stdin upload of the same archive. Integrity,
   authentication and version failures never authorize a transfer fallback.
3. Verify the archive before extraction/install on the remote machine. The
   fallback additionally verifies it locally before uploading; its download is
   limited to 512 MiB and ten minutes. Use private temporary directories and
   bounded SSH transfer/output, with cleanup on completion and failure.
4. Bundle native-target Node >=22, the complete Agent runtime and host-core,
   launcher, installer and `SHA256SUMS`. Verify staged files, reject unsafe
   manifest paths/special files, install content-addressed version directories,
   then atomically replace the `current` symlink. Linux kernel-owned locks
   serialize deployment and installation. A failed stage does not overwrite the
   previous installed contents. A legacy real `current` directory is refused,
   not silently deleted or converted.
5. Bootstrap reuse requires an external `.release.sha256` receipt matching the
   version, trusted archive digest and installed manifest digest, plus successful
   read-only `install.sh --verify`. The receipt is outside immutable version
   contents. Legacy bundles without a manifest do not qualify for verified reuse.
6. Separate install/pair from daily readiness. The supervisor starts only the
   installed Host when necessary, prefers bundled Node, uses `--port 0` without
   `--pair`, and preserves Host identity/device credentials. Validate fresh
   loopback readiness, version and saved Host ID before forwarding; validate
   RACP Host identity again at initialization/reconnect. Older descriptors without
   an optional Host ID remain readable. Ordinary disconnect does not kill a Host
   that another client may use.
7. New remote workspace projects keep Agent execution, models, API credentials,
   permissions and sessions on Desktop. Remote tools/files and root repository
   instructions use owner-only workspace services. Local global instruction
   defaults precede remote root instructions; remote HOME and nested instruction
   traversal are not part of this operation. Legacy remote-Agent mode remains.
8. Recovery never replays Write/Edit/Bash. A lost transport reply produces
   `REMOTE_MUTATION_OUTCOME_UNKNOWN`, non-retriable, requiring inspection before
   an explicit user retry. Offline Host selection may request readiness but must
   not turn tool execution into an automatic reconnect/replay path. UI errors
   use approved localized categories, never raw SSH stderr or credentials.

## Trust and compatibility

SHA-256 authenticates bytes relative to the trusted release descriptor; it is
not an independent cryptographic signature. The candidate does not add signed
manifest verification or protect against compromise of the release publisher,
the SSH account, or its installed files/receipt. SSH host authentication, private
credentials and canonical workspace containment remain mandatory.

No database migration or model-key synchronization is introduced. Existing direct
connections, SSH authentication modes and legacy remote-Agent sessions retain
ownership. Legacy Host installations may need explicit reinstall/upgrade to gain
the bundled runtime and workspace capabilities; daily startup is not an updater.

## Alternatives

- Remote-only download: retains the original offline-network failure.
- Always upload: adds unnecessary local transfer and discards the working remote
  path. The narrowly classified fallback is sufficient.
- Trust version alone or a self-modifiable manifest: accepts damaged/different
  bytes; verified reuse needs the release-bound external receipt and file checks.
- Reinstall/re-pair on reconnect: changes credentials and process lifecycle for
  an ordinary connection failure. Separate readiness preserves ownership.

## Consequences and qualification

Desktop may now send verified release executable bytes through the user's SSH
session. This is an explicit, limited amendment to ADR 0292/security §3.4, not
permission to upload arbitrary model-generated executables or bypass checks.
New bundles remove the system-Node prerequisite, not the supported Linux ABI or
basic POSIX/SSH/hash/archive/flock requirements.

This remains Experimental. Shell, packaging, protocol and isolated local-model
fixtures are not real Linux SSH release acceptance. A macOS development host
without a Linux target cannot qualify Linux kernel-lock crash recovery, fresh
x64/arm64 SSH installation, blocked remote GitHub, reboot/process recovery or
password-only login. Those gates are documented in E2E-REMOTE-SSH-OPTIMIZATION.
Published `v0.18.0-beta.6` assets are immutable: publish a new matching Desktop
and Host release rather than replacing that tag's bundles. Full R2 terminal and
reverse-relay acceptance is not implied by this decision.
