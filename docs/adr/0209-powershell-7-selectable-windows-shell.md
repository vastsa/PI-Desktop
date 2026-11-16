# ADR 0209: PowerShell 7 as a selectable Windows command shell

- Status: Accepted (issue #151, merged in #191)
- Date: 2026-09-10
- Decision: D381
- Amends: ADR 0054 §1 (Windows catalog table and Windows catalog list)
- Related: [03-runtime/03-tools-and-permissions.md](../spec/03-runtime/03-tools-and-permissions.md)

## Context

ADR 0054 froze a Windows catalog of `windows-powershell`, `cmd`, and `git-bash`,
where `windows-powershell` resolves the in-box Windows PowerShell 5.1. PowerShell
7 is a separate side-by-side product that never replaces 5.1, so a user who
installed `pwsh.exe` had no way to select it and `Bash` kept launching 5.1, as
Issue #151 reports.

## Decision

### 1. A fifth stable ID: `windows-pwsh`

The Windows catalog gains `windows-pwsh` (`PowerShell 7`), selectable from
Settings and persisted in `defaultCommandShell` like every other entry, and it
joins the `CommandShellId` protocol union.

### 2. Resolution order and failure guidance

`windows-pwsh` resolves `%ProgramFiles%\PowerShell\7\pwsh.exe` first — probing
`%ProgramW6432%` as well so a 32-bit host on 64-bit Windows finds the real
64-bit install — and then `pwsh.exe` on PATH, which covers Store, user-scope, and
portable installs. A miss returns `SHELL_NOT_FOUND` with `PWSH_MISSING_GUIDANCE`
naming both searched locations.

### 3. One shared invocation contract

PowerShell 7 accepts the same non-interactive flags as 5.1, so both IDs keep the
`powershell` dialect and share the pinned script with its UTF-8 output setup and
`$LASTEXITCODE` propagation, while the distinct catalog ID keeps the pinned turn
identity and `COMMAND_SHELL_CHANGED` comparing exactly.

### 4. The platform default does not change

`windows-powershell` remains the default for a fresh Windows install and the
value unset `defaultCommandShell` falls back to, so PowerShell 7 is only ever an
explicit Settings choice. `windows-pwsh` sits directly after the in-box entry, so
a persisted `windows-powershell` that becomes unavailable resolves to
`windows-pwsh` before `cmd` under ADR 0054 §1's existing first-available rule,
which cannot change the command language.

## Consequences

- Windows users can run agent commands under PowerShell 7 while 5.1 stays
  available and remains the default.
- One protocol ID is added, so settings validation and the type unions move with
  it; no RPC method, tool name, or storage migration is needed, and an unknown ID
  is still rejected as before.
- A missing PowerShell 7 keeps the entry visible and unavailable, the same
  presentation `git-bash` already uses, and the reordered fallback is
  unreachable on a normal install.

## Alternatives

- Make `windows-powershell` prefer `pwsh.exe` when present — rejected: it
  silently changes an existing user's shell and makes turn identity ambiguous.
- Let the user configure an arbitrary `pwsh.exe` path — rejected: catalog policy
  and identity validation depend on a closed ID set.
