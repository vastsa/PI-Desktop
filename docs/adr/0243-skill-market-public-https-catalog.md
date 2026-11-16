# ADR 0243: Skill market public-HTTPS catalog fetch

- Status: Accepted
- Date: 2026-09-13
- Decision: D413
- Amends: ADR 0009
- Issue: #287
- PR: #290

## Context

Settings → Skills gained a Market view that installs community `SKILL.md`
documents through the existing `skills.create` write path. The renderer CSP only
allows localhost, so catalog discovery and document fetch run in Electron main.

## Decision

1. Keep a single I/O-free classifier in `packages/shared`
   (`isSafePublicHttpsUrl`, `isPublicHostname`, `isPublicIpLiteral`).
2. Main-process fetches go through `createPublicHttpsClient`: HTTPS only,
   route-aware DNS classification, direct-route address pinning when a mixed DNS
   answer contains rejected addresses (ADR 0321), `redirect: "manual"` with
   per-hop re-validation, and retries only for non-policy failures.
3. The renderer never fetches catalog or document URLs.
4. Scanned and catalog ids are sanitized to host `valid_capability_id` before
   they reach the UI.
5. Preview shows the assembled body (skill text plus inlined sibling markdown).
6. Builtin catalog titles are English (ADR 0009).

## Consequences

- User-added `https://github.com/org/repo` sources make main walk the git tree
  and pull jsDelivr copies.
- Installing a skill still writes model instructions.
- MCP market must import `public-network.ts` instead of copying the classifier.

## Alternatives

- Plugin-marketplace host allowlist: too narrow for user GitHub sources.
- Directory install (`~/.agents/skills/<slug>/`): incompatible with the current
  single-file user-skill model.
- Pin fetched IPs into undici: stronger against rebinding, but would skip
  Chromium's proxy stack that `net.fetch` honors.
