# ADR 0308: Remote session entry and a fail-closed backend router

- Status: Accepted for implementation
- Date: 2026-09-25
- Decision: D627
- Related: ADR 0286 (D449, amended here — see §3), ADR 0292 (D453),
  `02-architecture/05-remote-agent-control.md` §5.2,
  `05-security/02-remote-control-security.md` §3.4, §7,
  `06-delivery/07-remote-control-rollout.md` §2 R2

## Context

ADR 0286 delivered the desktop-side kernel: a backend router, a
transport-agnostic backend, and an event bridge let a paired host answer
renderer calls. ADR 0292 added the SSH bootstrap so a host can be installed and
paired. But neither gave the user a way to *see* or *start* a remote session
from the UI. A paired host's sessions existed only in the kernel; the sidebar
still listed local sessions alone, and there was no create affordance for a
remote host.

R2's exit criteria (rollout §2 R2) require that a paired host's sessions are
visible and startable from the same surfaces as local ones, without leaking the
transport into the renderer (security §3.4) and without a lost or hostile host
being able to reach into the local workspace (security §7).

## Decision

Remote session entry is a sidebar section, a create dialog, and a set of
capability gates in the existing per-session surfaces. No new transport, no new
IPC seam beyond what ADR 0286 already exposes.

1. **One borderless sidebar group per paired host.** `RemoteHostSessions.tsx`
   renders a group per host with its connection state and its sessions, using
   the same row component as local threads. A disconnected host shows its state
   and offers no create action rather than surfacing dead rows.

2. **A create dialog that reuses the rename shell.** `NewRemoteSessionDialog.tsx`
   lets the user pick a project already registered on the host and start a
   session there. The desktop never picks a provider or model for a remote
   session: the host's own default is authoritative (§ Provider defaults).

3. **The backend router fails closed (amends ADR 0286 §3).** ADR 0286 returned
   the `ROUTE_LOCAL` sentinel when no backend was registered for a session id.
   That is correct for an *unknown* id, but a `remote:` id whose host is
   disconnected must not silently fall through to the local handler and run a
   remote-intended call against local state. The router now distinguishes an
   unregistered local id (routes local, unchanged) from a `remote:`-namespaced
   id whose backend is absent or offline (fails closed with a typed error). This
   is the one behavioral change to the ADR 0286 router; the router-off default
   for builds with no paired host is preserved byte-for-byte.

4. **Capability gating in the shared surfaces.** The Composer, the transcript
   `MessageRow`, and the work-panel `FilesTab` gate the operations a remote
   profile does not implement:
   - A remote transcript row has no edit, delete, or revision affordance; the
     host owns that history and the desktop does not synthesize it.
   - The Composer disables the mode and permission-mode pickers for a remote
     session: a remote turn runs under the host's configured mode, and the
     desktop does not send a local override the host would ignore.
   - The work-panel file tree reads only the tree the session's host refers to.

5. **Remote sessions leave the local workspace alone.** Selecting a remote
   session does not mutate the local workspace path, and the local project
   state stays as the user left it. Boot lists remote sessions and merges them
   into the session list without touching local session ownership.

6. **Bounded subscriptions, no focus stealing.** The connection subscribes to a
   host's sessions on demand and drops the subscription when the group is no
   longer shown; creating or receiving a remote session never steals focus from
   the user's current local session.

## Provider defaults

A remote session always runs under the host's default model. The desktop shows
no remote model picker: choosing a model for a remote session is out of scope
for R2, and the host is the authority for what it can run. This keeps the entry
surface honest about the one guarantee the host makes — that `turn/start` uses
whatever the host's `settings` names as default — and defers a remote picker to
a later stage.

## Invariants

- The renderer stays transport-agnostic: remote rows use the local row
  component and the local response shapes. Only the session id is namespaced.
- A `remote:` id whose host is offline fails closed; it never runs against local
  state.
- Selecting or creating a remote session never mutates the local workspace or
  steals focus.
- An empty host registry is a full no-op: the sidebar shows only local sessions
  and nothing subscribes.

## Out of scope

- **A remote model picker.** The host default is the only model a remote
  session uses.
- **Terminal work-panel client and reverse tool relay** (ADR 0286 Stages 5–6).
- **The resync watchdog**: `resync.required` is still dropped.
- **Search, tray, and notifications for remote sessions.**
- **Smart-stop settle for remote sessions.**

## Alternatives considered

- **Keep the ADR 0286 `ROUTE_LOCAL` fallthrough for every unregistered id.**
  Rejected: a `remote:` id whose host dropped would run against local state, a
  silent correctness and security failure. Failing closed on the namespace is
  the smallest safe change.
- **Let the desktop pick a model for a remote session.** Rejected: the host is
  the authority on what it can run, and a desktop-chosen model the host cannot
  serve would fail `turn/start` in a way the user cannot diagnose from the
  desktop.
- **A single flat session list with a transport badge.** Rejected: a per-host
  group makes connection state legible and keeps a disconnected host's dead rows
  from mixing with live local ones.

## Testing

`node --test` fixtures cover the fail-closed router (a `remote:` id with no
backend errors; a local id still routes local), the sidebar list-and-create
path, and the capability gates. The host half of the entry path is exercised by
`scripts/e2e-remote-host.mjs`
(`E2E-REMOTE-session-list-and-create`).

## Consequences

- The ADR 0286 router gains one branch: a `remote:` id with no live backend
  fails closed instead of routing local. Builds with no paired host are
  unaffected.
- The sidebar, Composer, transcript, and file tree gain remote-aware branches,
  each gated so a local session renders exactly as before.
- The remote entry surface ships behind the same experimental remote-control
  rollout as the rest of R2; see `06-delivery/07-remote-control-rollout.md`.
