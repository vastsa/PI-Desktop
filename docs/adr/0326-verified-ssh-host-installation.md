# ADR 0326: Verified SSH Host installation and daily startup

- Status: Accepted for experimental implementation; Linux SSH qualification and release publication pending
- Date: 2026-10-11
- Deciders: PI-Desktop maintainers (user-authorized Remote SSH optimization plan)
- Amends: [ADR 0292](0292-ssh-remote-host-bootstrap.md), specifically the executable-upload prohibition and remote GitHub-access prerequisite; the corresponding D375 deployment choice
- Related: [ADR 0293](0293-ssh-password-authentication.md), [Local Agent remote workspace tools](local-agent-remote-workspace-tools.md), [architecture §5.2](../spec/02-architecture/05-remote-agent-control.md#52-remote-host-over-an-ssh-tunnel-first-remote-topology), [security §3.4](../spec/05-security/02-remote-control-security.md#34-ssh-bootstrap-pairing-first-remote-topology)

## Context

The original bootstrap required system Node 22+ and outbound GitHub access on
the remote machine. Reusing installation/pairing for daily connection also risks
unnecessary downloads, process restarts and credential churn.

## Decision

1. Keep system OpenSSH, its host-key checks, configured identities/agent/jump
   hosts, and RACP-WS over loopback forwarding.
2. Resolve the matching Desktop version and published Linux x64/arm64 target.
3. Verify the archive before extraction/install on the remote machine.
4. Bundle native-target Node >=22, the complete Agent runtime and host-core,
   launcher, installer and `SHA256SUMS`.
5. Bootstrap reuse requires an external `.release.sha256` receipt matching the
   version, trusted archive digest and installed manifest digest, plus
   successful read-only `install.sh --verify`.
6. Separate install/pair from daily readiness.
7. New remote workspace projects keep Agent execution, models, API credentials,
   permissions and sessions on Desktop.
8. Recovery never replays Write/Edit/Bash.

## Trust and compatibility

SHA-256 authenticates bytes relative to the trusted release descriptor; it is
not an independent cryptographic signature. The candidate does not add signed
manifest verification or protect against compromise of the release publisher,
the SSH account, or its installed files/receipt.

No database migration or model-key synchronization is introduced. Existing
direct connections, SSH authentication modes and legacy remote-Agent sessions
retain ownership.

## Alternatives

- Remote-only download: retains the original offline-network failure.
- Always upload: adds unnecessary local transfer and discards the working remote
  path.
- Trust version alone or a self-modifiable manifest: accepts damaged/different
  bytes; verified reuse needs the release-bound external receipt and file
  checks.
- Reinstall/re-pair on reconnect: changes credentials and process lifecycle for
  an ordinary connection failure.

## Consequences and qualification

Desktop may now send verified release executable bytes through the user's SSH
session.

This remains Experimental.
