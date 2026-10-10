# Headless Host and experimental remote SSH MVP

`pi-host` coordinates the RACP server, Agent Host, Node Agent runtime, and Rust
host-core. Only Rust owns SQLite and provider persistence. RACP binds loopback;
SSH supplies the network boundary. No internal host-core RPC is exposed.

## Try the desktop workflow

Use a Desktop and Host bundle built from the same candidate.

1. Open **Settings → Remote Hosts (Experimental)**. Developer mode is not required.
2. Add an SSH host using your existing SSH key/configuration, or password where
   supported. Bootstrap downloads the same-version platform bundle and verifies
   the published checksum. The server needs Node and outbound release access.
3. Open **Conversations / New conversation** on the connected host.
4. Select eligible model configurations and explicitly consent to copying their
   API credentials to that host. Optionally set its default model. OAuth,
   CLI/plugin providers and local-only endpoints are excluded. Direct URL pairing
   does not offer credential copy.
5. Select a registered project, or enter an existing absolute remote project path.
   Create a conversation (Agent mode, Ask permissions).
6. Send text, approve/deny tools, answer questions, and inspect read-only Files /
   Review. Remote paths never activate a local workspace. Reconnect recovers
   subscriptions and pending requests without resending the turn.

The UI does not offer remote terminal, attachments, local model controls,
message edits, Plan/Goal creation, desktop plugin/MCP relay or cross-host handoff.
This is not full R2 acceptance.

**Release prerequisite:** automatic SSH install uses published release assets.
Building this branch does not update an existing release. Publish a matching
platform Host bundle before distributing the automatic-install path. For local
candidate testing, use the isolated acceptance commands below; do not point an
old Host at a candidate Desktop and assume provider import is available.

## Build and validate a candidate

From the repository root, with the existing host toolchain/dependencies:

```sh
pnpm build:js
pnpm --filter @pi-desktop/agent-runtime bundle
cargo build -p host-core --locked
node apps/pi-host/scripts/bundle.mjs --host-core "$PWD/target/debug/pi-desktop-host-core" --out "$PWD/apps/pi-host/dist-bundle/candidate"
PI_HOST_E2E_BUNDLE="$PWD/apps/pi-host/dist-bundle/candidate" node scripts/e2e-remote-mvp.mjs
node scripts/e2e-remote-mvp-ui.mjs
```

Set `--out <directory>` to place the Host bundle elsewhere, and use the actual
Cargo target path when sharing a host cache. The bundle must contain the complete
runtime manifest/chunks/assets, not only `sidecar.js`. Native files must match the
target platform. macOS requires an executable node-pty spawn helper; Linux does
not require that macOS-only helper.

In linked worktrees where the pnpm launcher rejects linked dependency state,
run the installed TypeScript compiler for the affected packages, the runtime
bundle script and Desktop's installed `electron-vite build` directly. Do not
install a second dependency environment just to execute these tests.

- `e2e-remote-mvp.mjs` starts a packaged Host, real Rust and Agent processes,
  Desktop main routing and a loopback-only mock model in temporary directories.
  It covers import/reimport, pairing, create/chat, approval across reconnect,
  exactly-once execution, transcript/files/diff, path containment and removal.
- `e2e-remote-mvp-ui.mjs` uses real React/Chromium components, the built stylesheet,
  a mocked IPC boundary and an isolated profile. It does not launch the user's app.
- Neither result is a real Linux SSH/Desktop release acceptance result. E2E-231
  remains the separate gate for release download, SSH/password login and recovery
  on another machine. Tests require no production credentials or paid model calls.

## Provider import operational behavior

The UI sends only IDs to Main. Main sends a version-1 payload over SSH stdin to
`node "$HOME/.pi-desktop/pi-host/current/pi-host.js" provider-import`. The CLI
forwards only this operation to the running Host's `pi-host/admin.sock`; it never
starts a second database writer. Custom data directories use `--data-dir`.

Data directories must be owned by the current user and mode 0700; the socket is
0600. Do not relax these permissions to work around `ADMIN_UNAVAILABLE`.

Copies are additive. Identical payloads reuse imported IDs; changed configurations
create a new row. Remotely changed/deleted rows are skipped. The returned summary
contains imported IDs, safe skip reasons and whether the default was set, never
credentials. `import_incomplete` means an earlier creation result was uncertain;
inspect the running Host and its provider inventory before retrying. Do not delete
the receipt journal to force another import. Removing a Desktop pairing closes
local connections but does not delete remote sessions, files or provider data.

See [remote architecture](../../docs/spec/02-architecture/05-remote-agent-control.md),
[security](../../docs/spec/05-security/02-remote-control-security.md), and
[rollout](../../docs/spec/06-delivery/07-remote-control-rollout.md).

## Candidate notes (unreleased)

- Experimental Remote Hosts is available without developer mode, with explicit
  model copy, project/session entry, text chat, approvals and read-only files/diffs.
- Complete runtime packaging and bounded reconnect recovery avoid missing chunks,
  duplicate turns, stale approval cards and remote-to-local routing fallback.
- No local data migration or database schema change. Existing local sessions and
  provider configuration are preserved. Full R2 and publication are not implied.
- An SSH bootstrap already downloading/installing has no mid-step cancellation
  interface yet. Closing prevents late registration and releases a returned forward,
  but does not undo or immediately interrupt an already-started remote installation.
