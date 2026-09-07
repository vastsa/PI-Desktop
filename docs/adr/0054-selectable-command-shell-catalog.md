# ADR 0054: Selectable command shell catalog and execution identity

- Status: Accepted for implementation (timeout bounds in §4 amended by ADR 0167 / D329)
- Date: 2026-07-31
- Baseline: `0.4.14`
- Protocol: v9
- Storage schema: v10

## Context

The Bash tool currently resolves one Bash implementation per process. That
prevents users from choosing the command language that matches their project
and makes a changed executable hard to detect. The protocol name and Agent
tool vocabulary must remain stable while shell selection becomes explicit and
host-authoritative.

## Decision

### 1. Host-owned shell catalog

Host-core exposes a platform-aware catalog with stable IDs:

| ID | Shell | Discovery |
|---|---|---|
| `windows-powershell` | native PowerShell | `powershell.exe`/native PowerShell on Windows |
| `cmd` | Windows Command Prompt | `cmd.exe` on Windows |
| `git-bash` | Git for Windows Bash | Git for Windows installation and PATH |
| `bash` | Unix Bash | `/bin/bash`, `/usr/bin/bash`, or an approved PATH entry on macOS/Linux |

The Windows catalog contains `windows-powershell`, `cmd`, and `git-bash`; the
Unix catalog contains `bash`. The catalog does not accept an arbitrary
renderer- or sidecar-supplied executable path.

Settings writes accept only an available ID for the current platform. Unknown,
unavailable, and wrong-platform IDs are rejected. If a persisted ID later
becomes unavailable, host-core intentionally selects the first available shell
in the platform catalog and reports `fallback: true`; if none is available,
Bash fails with `SHELL_NOT_FOUND`.

### 2. Persisted default and stable identity

The host persists one `defaultCommandShell` ID in app settings. Selection is
allowed only from the available catalog and only while the affected session is
idle. At turn launch, the runtime pins the effective shell ID and dialect. The
execution request carries the pinned ID; host-core resolves the catalog again
before spawn and rejects a changed effective ID or dialect with
`COMMAND_SHELL_CHANGED`. This identity check is about the catalog selection,
not executable path hashing. A runtime fallback is selected before the turn is
pinned; execution never silently changes shell after that point.

### 3. Stable Bash protocol contract

The Agent tool and host method remain `Bash` and `tools.execute`; shell choice
is data on the request, not a new `PowerShell`, `Cmd`, or `GitBash` tool name.
The command runs non-interactively in the originating session workspace with
the selected shell's documented invocation form.

Host-core streams stdout and stderr as separate ordered output events. The
final tool result remains bounded and records whether either stream was
truncated. No stream chunk may contain secrets or be attributed to another
session/turn.

### 4. Timeout and cancellation

Every Bash execution has a mandatory 60-second default timeout. A caller may
request a host-validated override only from 1 second through 300 seconds;
missing values use exactly 60 seconds, and out-of-range values are rejected.
Timeout and user abort terminate the complete process tree, not only the shell
leader: Unix uses a process group and Windows uses a job/process-tree boundary.
The host waits for shutdown, closes the stream, records the terminal outcome,
and returns `TOOL_TIMEOUT` or `TURN_ABORTED` without leaving an orphan.

## Consequences

- Users can choose the command language once and keep that default across
  sessions and restarts.
- A changed effective shell selection cannot receive commands under stale
  assumptions, while a persisted unavailable preference can recover through the
  intentional catalog fallback.
- Streaming makes long commands observable without weakening final result
  limits.
- The stable Bash protocol avoids multiplying tool schemas and compatibility
  paths.

## Alternatives rejected

### Always use Bash

Rejected because it excludes native Windows command workflows and makes the
user's shell preference invisible.

### Let the caller provide an arbitrary executable path

Rejected because it bypasses catalog policy and makes identity validation and
security review unreliable.

### Create one protocol tool per shell

Rejected because it breaks existing Bash skills and expands the permission and
audit matrix without adding authority.

## Related docs

- `docs/adr/0053-plan-checkpoint-artifact-and-execution-epoch.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/05-host-core-rust.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/03-runtime/07-process-model.md`
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/03-runtime/09-logging-and-observability.md`
- `docs/spec/03-runtime/16-tool-result-limits.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/05-security/01-security.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D190)
