# ADR 0045: Bash tool inherits the user's login-shell PATH

- Status: Accepted
- Date: 2026-08-02
- Related: [D084](../spec/08-meta/decisions-log.md) ·
  [Tools and permissions](../spec/03-runtime/03-tools-and-permissions.md)

## Context

The Bash tool runs agent commands through `bash -lc` (D084). A login bash
sources only the bash profile, so on macOS — where the default shell is zsh and
toolchains like nvm, pnpm, and Homebrew are initialized in `~/.zshrc` /
`~/.zprofile` — commands cannot resolve `node`, `npm`, `pnpm`, or anything else
that only the user's own shell exports. Launching the app from Finder/Dock
further shrinks the environment to a minimal GUI PATH.

## Decision

1. On Unix, the first Bash call probes the user's login shell for its PATH:
   `$SHELL` (fallback `/bin/zsh` → `/bin/bash` → `/bin/sh`) runs
   `-lic 'printf %s "$PATH"'` — `-l` sources login files, `-i` sources the
   interactive rc — with a 5s bound so a wedged rc cannot stall the tool.
   Only the last stdout line is kept, so rc banners cannot contaminate it;
   stderr is discarded (missing-tty/job-control noise).
2. The probed PATH is cached per process (`OnceLock`) and injected into every
   Bash subprocess via `cmd.env("PATH", ...)`.
3. The probe is strictly best-effort: on failure (no `$SHELL`, non-executable,
   non-zero exit, timeout) the host PATH is used unchanged. Windows keeps
   `bash -c` with the host environment (no change).
4. Agent commands remain POSIX bash; only the child environment's `PATH` is
   enriched. The resolved bash binary itself is unchanged.

## Consequences

- `node`/`npm`/`pnpm`, Homebrew tooling, and other login-shell exports resolve
  inside Bash tool calls, matching what a fresh terminal offers.
- `bash -lc` still re-runs the bash profile at startup; conda/brew hooks may
  prepend, dedupe, or reorder entries — the injected login PATH remains the
  base the user's bash profile builds on.
- One bounded subprocess per process lifetime (the probe) is the entire
  overhead; every later Bash call is cache-only.
- A slow or interactive-only user rc degrades gracefully to the previous
  behavior instead of failing the tool.

## Alternatives rejected

- **Run commands in `$SHELL` instead of bash:** breaks the D084 contract that
  agent commands are POSIX bash; zsh differences (`$path` array, echo/glob
  semantics) would silently fork behavior.
- **Source rc files from the wrapper command:** fragile — the command line
  would have to special-case every shell's rc grammar, and injected prefixes
  would appear in every result.
- **Bundle a default PATH in the host:** cannot know the user's toolchain;
  replicates the Finder-launch problem in disguise.
