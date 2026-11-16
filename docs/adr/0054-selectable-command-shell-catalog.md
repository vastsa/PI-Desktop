# ADR 0054: Selectable command shell catalog and execution identity

- Status: Accepted for implementation (timeout bounds in §4 amended by ADR 0167 / D329; the PowerShell 7 entry is added by ADR 0209 / D381)
- Date: 2026-07-31
- Related: ADR 0053, D190

## Context

The Bash tool resolved one Bash implementation per process, which kept users from
choosing a command language that matches their project and made a changed
executable hard to detect. Shell selection had to become explicit and
host-authoritative while the `Bash` tool vocabulary stayed stable.

## Decision

### 1. Host-owned shell catalog

Host-core exposes a platform-aware catalog of stable IDs — `windows-powershell`,
`windows-pwsh`, `cmd`, `git-bash` on Windows and `bash` on Unix — discovered only
through documented install locations or PATH. It never accepts an arbitrary
executable path from the renderer or the sidecar. Windows PowerShell 5.1 stays the
platform default and `windows-pwsh` is never selected implicitly, so choosing it
cannot surprise an existing user. Settings accept only an available ID for the
current platform; a persisted ID that later becomes unavailable falls back to the
first available shell with `fallback: true`, and an empty catalog fails with
`SHELL_NOT_FOUND`.

### 2. Persisted default and stable identity

One `defaultCommandShell` ID is persisted in app settings and may change only
while the affected session is idle. At turn launch the runtime pins the effective
shell ID and dialect, and host-core re-resolves the catalog before spawn,
rejecting a changed identity with `COMMAND_SHELL_CHANGED`. The check covers
catalog selection, not executable path hashing, and no fallback happens after the
turn is pinned.

### 3. Stable Bash protocol contract

The Agent tool stays `Bash` and the host method stays `tools.execute`; the shell is
request data rather than a separate tool name. The command runs
non-interactively in the originating session workspace using the selected shell's
documented invocation form. Host-core streams stdout and stderr as separate
ordered events, the final result stays bounded and records truncation, and no
chunk may carry secrets or another session's output.

### 4. Timeout and cancellation

Every execution has a mandatory default timeout with a host-validated override
range, and out-of-range values are rejected (bounds amended by ADR 0167). Timeout
and abort terminate the whole process tree through a Unix process group or a
Windows job/process-tree boundary, then close the stream and return
`TOOL_TIMEOUT` or `TURN_ABORTED` without leaving an orphan.

## Consequences

- Users pick a command language once and keep it across sessions and restarts.
- A stale shell assumption cannot receive commands, while an unavailable
  persisted preference recovers through the intentional catalog fallback.
- The single `Bash` schema keeps skills, permissions, and auditing unchanged.

## Alternatives

- One protocol tool per shell: breaks existing Bash skills and grows the
  permission matrix without adding authority.
- Caller-supplied executable path: bypasses catalog policy and makes identity
  validation unreliable.
