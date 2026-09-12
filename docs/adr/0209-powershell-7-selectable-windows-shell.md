# ADR 0209: PowerShell 7 as a selectable Windows command shell

- Status: Accepted (issue #151, merged in #191)
- Date: 2026-09-10
- Baseline: `0.14.6`
- Protocol: v11 (unchanged; additive catalog ID)
- Storage schema: v14 (unchanged; no migration)
- Decision: D381
- Amends: ADR 0054 §1 (Windows catalog table and Windows catalog list)
- Related: [03-runtime/03-tools-and-permissions.md](../spec/03-runtime/03-tools-and-permissions.md),
  [03-runtime/01-ipc-protocol.md](../spec/03-runtime/01-ipc-protocol.md),
  [03-runtime/06-host-rpc-protocol.md](../spec/03-runtime/06-host-rpc-protocol.md),
  [04-ux/06-settings-ia.md](../spec/04-ux/06-settings-ia.md),
  [05-security/01-security.md](../spec/05-security/01-security.md),
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md) (E2E-112)

## Context

ADR 0054 froze a Windows catalog of `windows-powershell`, `cmd`, and `git-bash`.
The `windows-powershell` entry resolves the in-box Windows PowerShell 5.1
(`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`).

PowerShell 7 (`pwsh.exe`) is a separate product that installs side by side with
5.1 and never replaces it. A user who wants PowerShell 7 therefore had no way to
select it: the catalog exposed no entry, and `Bash` kept launching 5.1 even after
the user installed 7. Issue #151 reports exactly that, and the codebase confirms
the gap — `crates/host-core/src/tools/shell.rs` contains no `pwsh.exe`
resolution path, and `packages/shared/src/command-shells.ts` lists four stable
IDs only.

## Decision

### 1. A fifth stable ID: `windows-pwsh`

The Windows catalog gains `windows-pwsh` (`PowerShell 7`), selectable from
Settings and persisted in `defaultCommandShell` like every other entry. The ID is
stable and platform-scoped, and joins the `CommandShellId` protocol union.

### 2. Resolution order and failure guidance

`windows-pwsh` resolves, in order:

1. `%ProgramFiles%\PowerShell\7\pwsh.exe`, which is where a machine-scope MSI or
   `winget --scope machine` install lands. `%ProgramW6432%` is probed as well,
   so a 32-bit host process on 64-bit Windows — where `ProgramFiles` points at
   the x86 tree — still finds a real 64-bit install.
2. `pwsh.exe` on PATH, which covers Store, user-scope, and portable installs.

Neither location is discoverable by guessing, so a miss returns
`SHELL_NOT_FOUND` with guidance that names both searched locations and points at
installing PowerShell 7. The wording lives in `PWSH_MISSING_GUIDANCE` next to the
resolver.

### 3. One shared invocation contract

PowerShell 7 accepts the same non-interactive flags as 5.1 (`-NoLogo
-NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -Command`), so
both IDs keep the `powershell` dialect and share the existing pinned script,
including the UTF-8 output setup and `$LASTEXITCODE` propagation. The catalog ID
stays distinct so the pinned turn identity, the folded settings write path, and
`COMMAND_SHELL_CHANGED` still compare exactly.

### 4. The platform default does not change

`windows-powershell` remains the default for a fresh Windows install, keeps
`is_default`, and stays the value `defaultCommandShell` falls back to when unset.
PowerShell 7 is never chosen for a user who did not ask for it: selecting it is an
explicit Settings action.

Catalog order still decides the first-available fallback (ADR 0054 §1), and
`windows-pwsh` sits directly after the in-box entry, so a persisted
`windows-powershell` that later becomes unavailable now resolves to
`windows-pwsh` before `cmd`. This follows the existing fallback rule instead of
adding a new one, and it cannot change the command language — both entries share
the `powershell` dialect. On Windows the in-box 5.1 entry is effectively always
present, so the reordering is not reachable for a normal install; the catalog
test covers both steps of the order so the behavior is pinned either way.

## Consequences

- Windows users can run agent commands under PowerShell 7 while keeping 5.1
  available as a separate, still-default choice.
- The protocol gains one ID, so the folded settings validation, the catalog
  E2E lane (E2E-112), `scripts/e2e-plan.mjs`, and the protocol type unions move
  with it. No new RPC method, no new tool name, and no storage migration are
  needed: an unknown ID is rejected exactly as before, and a persisted
  unavailable `windows-pwsh` recovers through the first-available fallback.
- One existing behavior moves: a persisted `windows-powershell` that becomes
  unavailable now falls back to `windows-pwsh` instead of `cmd`, because the new
  entry sits earlier in catalog order. The dialect is unchanged, and the case is
  unreachable on a normal Windows install, but the existing catalog test is
  updated to pin both steps of the order rather than only its first result.
- A machine without PowerShell 7 keeps the entry visible and unavailable, the
  same presentation `git-bash` already uses.

## Alternatives rejected

### Make `windows-powershell` prefer `pwsh.exe` when present

Rejected: it silently changes the shell an existing user already runs, and it
makes the pinned turn identity ambiguous between two different executables that
share a dialect. It also cannot express "use 5.1" once 7 is installed, which is
the choice ADR 0054 §1 deliberately granted by freezing the catalog.

### Let the user configure an arbitrary `pwsh.exe` path

Rejected: ADR 0054 already rejected renderer- or sidecar-supplied executable
paths, because catalog policy and identity validation depend on a closed ID set.
A `PI_DESKTOP_*` env override could be added later for unusual installs, but it
is not needed for the install layouts above and is deliberately left out of this
change.

### Add a `PowerShell7` tool name

Rejected: ADR 0054 §3 keeps `Bash` as the tool and protocol name and treats shell
choice as request data. A second tool name would multiply permission and audit
surfaces without adding authority.
