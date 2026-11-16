# ADR 0045: Bash tool inherits the user's login-shell PATH

- Status: Accepted (amended 2026-09-20, D600 / issue #571)
- Date: 2026-08-02
- Related: D084, D181

## Context

The Bash tool runs agent commands through `bash -lc` (D084), which sources only
the bash profile. On macOS, where zsh initializes nvm, pnpm, and Homebrew in
`~/.zshrc` / `~/.zprofile`, commands cannot resolve anything only the user's own
shell exports, and a Finder/Dock launch reduces the environment to a minimal GUI
PATH.

## Decision

On Unix the first Bash call probes the user's login shell for its PATH — `$SHELL`
(fallback `/bin/zsh` → `/bin/bash` → `/bin/sh`) running
`-lic 'printf %s "$PATH"'` under a time bound, keeping only the last stdout line
— and caches it per process, injecting it into every Bash subprocess via
`cmd.env("PATH", ...)`. The probe is best-effort: any failure leaves the host PATH
unchanged, and Windows keeps `bash -c` with the host environment. Agent commands
remain POSIX bash; only the child PATH is enriched.

## Consequences

- `node`/`npm`/`pnpm`, Homebrew tooling, and other login-shell exports resolve
  inside Bash calls, matching a fresh terminal.
- `bash -lc` still re-runs the bash profile, so conda/brew hooks may reorder
  entries on top of the injected login PATH.
- Stdio MCP servers from Electron main use the same login-shell PATH (D600 /
  issue #571), since they share the Finder/Dock GUI PATH problem.

## Alternatives

- Run commands in `$SHELL`: breaks the D084 POSIX-bash contract.
- Source rc files from the wrapper command: each shell's rc grammar would need a
  special case.
