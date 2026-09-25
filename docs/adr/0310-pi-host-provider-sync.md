# ADR 0310: pi-host admin socket and SSH provider sync

- Status: Accepted for implementation
- Date: 2026-09-25
- Decision: D629
- Related: ADR 0292 (D453, supplemented here), ADR 0286 (D449),
  ADR 0304 (relaxed network mode),
  `02-architecture/05-remote-agent-control.md` §5.2,
  `05-security/02-remote-control-security.md` §3.4, §7

## Context

ADR 0292 bootstrapped and paired a host, but left provider configuration
explicitly out of scope: "a freshly bootstrapped host still fails `turn/start`
closed with `MODEL_NOT_CONFIGURED` until a provider is configured on it." The
only way to configure a remote host's providers was to log into the machine and
run the host's own tooling by hand.

R2 needs a desktop action that copies the providers the user already configured
locally — API keys included — to a paired SSH host, under the two boundaries the
security spec fixes (§3.4): keys never travel in argv, logs, or over RACP, and
the app never spawns a second host-core to do the work. Providers hold secrets,
and RACP is the wrong channel for a secret: it is a session-scoped protocol, not
an admin one.

## Decision

Provider sync is a manual desktop action that drives `pi-host provider-import`
over the existing SSH channel's stdin, which hands the payload to the *running*
host over a new owner-only Unix admin socket.

1. **A local admin socket owned by the running host
   (`admin-socket.ts`).** `<dataDir>/pi-host/admin.sock`, directory `0700`,
   socket `0600`, one JSON request per connection, capped at 1 MiB. It is the
   only channel that carries provider keys into a running host, and it exists
   only on the host's own machine — never on the network, never on Windows
   (where it is disabled and provider import is unavailable). If another
   `pi-host` already owns the socket, the second one runs without the admin
   channel rather than stealing it.

2. **`pi-host provider-import [--data-dir <dir>]`.** The CLI reads a capped JSON
   payload from stdin, connects to the admin socket, and prints exactly one of
   `PI_HOST_PROVIDERS {summary}` (exit 0) or `PI_HOST_FAILED {"code":..}`
   (exit 1). The key is in the stdin payload and nowhere else: not in argv, not
   in the summary, not in any log line. The summary shape is
   `{imported[{sourceId, providerId, action}], skipped[{sourceId, reason}],
   defaultSet}`.

3. **Keys travel only on SSH stdin.** The desktop runs the CLI on the host via
   `execWithInput(command, input)` (ADR 0292's transport port), piping the
   payload into the remote process's stdin. The key therefore crosses exactly
   one boundary — the SSH channel the user already trusts — and never lands in a
   remote file, an argv, or a RACP frame.

4. **Idempotent upsert through the running host-core.** The admin handler maps
   each `sourceId` (the desktop provider id) to the host row it created, via
   `<dataDir>/pi-host/provider-sync.json`. A first sync `creates`; a second
   `updates` the same row instead of duplicating it. A plugin-owned row is
   skipped, never overwritten. Nothing is ever deleted. When the payload names a
   `defaultModel`, the handler sets the host's default provider and model so a
   freshly synced host can answer `turn/start` immediately.

5. **A shared eligibility rule (`packages/shared/src/provider-sync.ts`).**
   `isSyncableProvider` and `PROVIDER_SYNC_MAX_PROVIDERS = 64` live in shared so
   the renderer's Sync dialog and the host-side validator agree on which
   providers may be copied and how many. A provider that cannot be synced (an
   OAuth/sign-in provider with no portable key) is neither listed nor
   preselected.

6. **A manual, explicit desktop action.** Settings ▸ Remote Hosts ▸ "Sync
   models…" opens `SyncProvidersDialog`, offered only on connected SSH hosts.
   The user selects providers and optionally sets the host default. Sync is
   never automatic and never runs unasked. After a bootstrap succeeds, the
   desktop surfaces a hint that the host has no providers yet; it still does not
   sync on its own.

7. **The default model reconciles against the local default.** When the local
   default provider leads the selection and carries the local default model,
   that model becomes the host default; otherwise the first model, then the
   provider's `defaultModelId`. This keeps a synced host's default aligned with
   what the user runs locally without a second round-trip.

## Invariants

- No provider key ever appears in argv, a log line, the import summary, or a
  RACP frame. The only channels a key crosses are the encrypted local store, the
  SSH stdin, and the admin socket — all owner-only.
- The admin socket is `0600` under a `0700` directory, on loopback-free local
  IPC only, and disabled on Windows.
- No second host-core is spawned to import: the payload reaches the already
  running host over its admin socket.
- Re-import is idempotent per `sourceId`: update, never duplicate; plugin-owned
  rows are skipped; nothing is deleted.
- Sync is manual and explicit; nothing is copied without a user action.

## Out of scope

- **Automatic or scheduled sync.** Every sync is a manual action.
- **Removing providers on the host.** Import only creates or updates.
- **A remote model picker** (see ADR 0308): a remote session runs under the
  host default this import sets.
- **Non-SSH transports for import.** The channel is the SSH stdin path from ADR
  0292; a direct-URL host has no admin reach.

## Alternatives considered

- **Carry provider config over RACP.** Rejected: RACP is a session protocol,
  not an admin one, and a device token authenticates a viewer/owner of
  sessions, not a machine administrator. Keys do not belong on that channel
  (security §3.4).
- **Spawn a second host-core with `--import` and let it write the store.**
  Rejected: two host-cores contend for the same SQLite ownership (ADR 0011), and
  the running host would not see the new providers without a restart.
- **Write providers into a file the host reads on next boot.** Rejected: it
  needs a restart to take effect and leaves keys in a file on disk longer than
  the one-shot socket request does.
- **A network admin endpoint on the host.** Rejected by security §7: the host
  binds loopback for RACP only and opens no other listener; a local Unix socket
  keeps admin strictly on-machine.

## Testing

`vitest` covers the admin request parser (version, `sourceId`, `secretValue`,
unknown-field, and count limits), the socket's 1 MiB cap and owner-only modes,
and the idempotent upsert (create then update, plugin-owned skip, default set).
The end-to-end path is `scripts/e2e-remote-host.mjs`
(`E2E-REMOTE-provider-import-enables-turn`): a loopback mock model records its
`Authorization` header, `provider-import` copies a provider with the key on
stdin, the summary shows `created`/`defaultSet`, the key appears in no CLI or
host output, the socket is `0600` and its dir `0700`, a re-import `updates`, and
the next turn is admitted and reaches the model as a `Bearer` header before the
session returns to idle.

## Consequences

- `pi-host` gains a `provider-import` subcommand and an owner-only admin socket;
  both are inert until the desktop drives them over SSH.
- A freshly bootstrapped host can be made turn-ready from the desktop without a
  manual login, closing the ADR 0292 gap.
- The desktop's Sync dialog and the host validator share one eligibility rule,
  so the two ends cannot drift on which providers are syncable.
- Provider sync ships behind the experimental remote-control rollout; see
  `06-delivery/07-remote-control-rollout.md`.
