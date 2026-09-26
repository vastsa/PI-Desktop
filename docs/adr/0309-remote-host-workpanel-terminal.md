# ADR 0309: WorkPanel terminal runs only on a remote Host

- Status: Accepted for implementation
- Date: 2026-09-25
- Related: ADR 0108, ADR 0205, ADR 0286, ADR 0292, ADR 0308,
  `02-architecture/05-remote-agent-control.md` §5.2,
  `03-runtime/19-remote-agent-control-protocol.md` §6.2,
  `05-security/02-remote-control-security.md` §§4.1 and 7,
  E2E-058, E2E-231
- Amends: ADR 0108 for remote Host sessions only

## Context

ADR 0108 removed the local WorkPanel shell to avoid a second local process
lifecycle, native PTY dependency, and plugin shell permission. The later R2
remote-host profile already runs a PTY as the `pi-host` user on the remote
machine and explicitly requires a WorkPanel terminal. The desktop currently
has no terminal renderer or IPC path, and the Host operations do not yet bind a
terminal to the authorized principal, session, and active connection.

Remote development also needs an interactive shell that runs where the remote
workspace lives. Requiring users to leave the desktop for an external SSH
terminal would leave the specified R2 user path incomplete.

## Decision

1. **Keep local sessions terminal-free.** ADR 0108 remains in force for local
   sessions and plugin-contributed surfaces. The desktop does not start a
   local PTY, and no plugin receives a PTY API.
2. **Add a remote-only WorkPanel terminal.** It appears for a remote session
   only when its Host advertises terminal capability. The renderer uses
   xterm.js to display and edit a PTY owned by that remote Host; Electron Main
   routes the typed IPC through the existing RACP adapter. It never falls
   through to a local terminal handler.
3. **Use the session root as the remote working directory.** The Host resolves
   that directory from its own session record. The shell runs with the
   permissions of the `pi-host` OS user; the session root is a working
   directory, not a filesystem sandbox. The UI identifies the remote Host and
   session so users can see where commands run.
4. **Authorize the first SSH topology for the paired owner only.** Terminal
   operations require an owner role on a device credential issued by SSH
   pairing. Controllers, approvers, viewers, and pairing-only connections
   cannot open or operate terminals. A future Gateway `terminal` scope is not
   enabled by this decision.
5. **Bind every terminal to its session and principal.** Reattach checks both
   values. Input, resize, and close also require the active RACP connection
   that opened or reattached the terminal. Releasing an older connection must
   not detach a newer one.
6. **Make open safe to retry after a lost response.** A client supplies a
   stable `openRequestId` for one terminal tab. Repeating that ID for the same
   owner and session reattaches to the existing PTY instead of spawning a
   second shell. Terminal input is never replayed after a disconnect; output
   is recovered only from the Host's bounded replay ring.
7. **Preserve Host ownership.** Closing the WorkPanel tab explicitly closes
   its PTY. Collapsing the panel, switching sessions, or losing the transport
   detaches the output sink but leaves the remote process running so it can be
   reattached. Host shutdown closes all PTYs.

## Consequences

- The desktop adds a terminal renderer dependency but no local PTY runtime.
  `node-pty` remains optional and owned by the `pi-host` bundle.
- E2E-058 continues to verify that local sessions have no WorkPanel terminal;
  E2E-231 covers the remote-only terminal path and its SSH recovery.
- The Host RACP operation catalog requires `owner` for terminal operations.
  The handler also verifies that the credential is an SSH-paired device and
  checks terminal ownership before every action.
- A lost open response can be retried with the same request id. A user must
  deliberately submit input again after reconnect because replaying terminal
  input could repeat a command.

## Alternatives considered

### Keep all interactive shells in an external terminal

Rejected for remote sessions: R2 explicitly puts the remote terminal in the
WorkPanel, where it can be scoped to the selected remote session and recover
its output after an SSH drop. External SSH remains available to users who
prefer it.

### Restore a local WorkPanel terminal as well

Rejected: it reintroduces the local PTY lifecycle and permissions that ADR
0108 intentionally removed. Remote shell support does not require a local PTY.

### Allow every controller to run a shell

Rejected for the first SSH topology: pairing currently issues the desktop an
owner device credential, and no controller terminal-scope policy exists. A
later multi-principal topology must add and test its own explicit terminal
scope before broadening access.
