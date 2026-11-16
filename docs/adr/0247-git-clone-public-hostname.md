# ADR 0247: Git clone accepts only syntactically public hosts

- Status: Accepted
- Date: 2026-09-14
- Related: D416, ADR 0243, ADR 0245

## Context

Home "Clone git project" runs `git clone` with a user-supplied remote, and the parser
rejected `file:` URLs and embedded passwords but still accepted loopback, RFC1918,
link-local, and IPv6 loopback literals. Unlike the market fetchers (ADR 0243 /
ADR 0245), git uses its own HTTP and SSH stacks, so a Main-process DNS pin cannot
apply.

## Decision

`parseGitCloneUrl` reuses `isPublicHostname` from the shared network guards for URL
hosts and `git@host:path` hosts, rejecting loopback, unspecified, private, CGNAT,
link-local, multicast, reserved, documentation, ULA, site-local, `.localhost`,
`.local`, and `.internal` names. Protocols stay `https`, `http`, `ssh`, and `git`, so
SSH and HTTPS GitHub remotes keep working while `file:` URLs and URL passwords stay
rejected. Git still resolves DNS itself, so clone traffic is not pinned and a public
hostname resolving to a private address remains accepted residual risk.

## Consequences

- Loopback and LAN literal clones fail before `git` runs; public hosts still clone by
  name, and a private host by literal IP needs an out-of-app remote.
- That convenience loss is intentional, and the residual rebinding risk is documented
  rather than pinned as the market fetchers do.
