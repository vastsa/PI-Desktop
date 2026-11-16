# ADR 0247: Git clone accepts only syntactically public hosts

- Status: Accepted
- Date: 2026-09-14
- Deciders: PI-Desktop core
- Related: ADR 0243, ADR 0245, D416

## Context

Home "Clone git project" runs `git clone` with a user-supplied remote
(`apps/desktop/src/lib/git-clone-url.ts`). The parser already rejected `file:`
URLs and embedded passwords so a clone could not read arbitrary local paths or
smuggle credentials in the URL.

## Decision

1. `parseGitCloneUrl` reuses `isPublicHostname` from
   `packages/shared/src/public-network.ts` for URL hosts and `git@host:path`
   hosts.
2. Protocols stay `https`, `http`, `ssh`, and `git`.
3. Git still resolves DNS and opens sockets itself.

## Consequences

- Accidental or malicious clones to loopback/LAN IP literals fail in the
  renderer before `git` runs.
- Cloning a public git host by DNS name still works, including HTTP remotes.
- Operators who clone from a private git host by literal IP must use an
  out-of-app git remote; that is an intentional reduction in convenience.
- Residual risk: a public hostname can still resolve to a private address inside
  git.

## Alternatives considered

- **Apply market DNS pin to git clone:** rejected; git speaks SSH and its own
  HTTP, and replacing it is out of scope.
- **HTTPS-only remotes:** rejected; SSH `git@host:path` is the common GitHub
  path and is not an HTTP SSRF vector in Electron Main.
