# ADR 0243: Skill market public-HTTPS catalog fetch

- Status: Accepted
- Date: 2026-09-13
- Related: D413, issue #287, PR #290
- Amends: ADR 0009

## Context

The Settings → Skills Market view installs community `SKILL.md` documents through
the existing `skills.create` write path. The renderer CSP allows only localhost, so
catalog discovery and document fetch run in Electron main, where a naive
`net.fetch` would follow redirects onto loopback or RFC1918 space. The plugin
marketplace's fixed host allowlist cannot cover user-supplied GitHub repositories,
and MCP market (#285) needs the same classifier.

## Decision

A single I/O-free classifier lives in `packages/shared` (`isSafePublicHttpsUrl`,
`isPublicHostname`, `isPublicIpLiteral`), which the skill market wraps as
`isSafeSkillSourceUrl` and the future MCP market imports. Main-process fetches go
through `createPublicHttpsClient`: HTTPS only, route-aware DNS classification,
direct-route address pinning when a mixed answer contains rejected addresses
(ADR 0321), `redirect: "manual"` with per-hop re-validation, and retries only for
non-policy failures. The renderer never fetches catalog or document URLs, install
stays `skills.create`, and host-core stays unaware of the market. Scanned and
catalog ids are sanitized to host `valid_capability_id` before reaching the UI,
preview shows the assembled body including inlined sibling markdown, a document
that would exceed `MAX_SKILL_BYTES` cannot be installed, and builtin catalog titles
are English per ADR 0009.

## Consequences

- User-added `https://github.com/org/repo` sources make main walk the git tree and
  pull jsDelivr copies; the boundary is public HTTPS plus public resolved IPs, and
  DNS rebinding between lookup and `net.fetch` stays a residual risk.
- Installing a skill still writes model instructions: preview is the disclosure,
  and `verified` on builtin rows is not a signature.
- MCP market must import `public-network.ts` instead of copying the classifier.
