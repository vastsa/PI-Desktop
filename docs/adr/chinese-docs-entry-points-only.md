# ADR: Chinese documentation keeps entry points only

- Status: Accepted
- Date: 2026-11-16
- Related: amends ADR 0079

## Context

ADR 0079 required a path-for-path Simplified Chinese companion for every page
under `docs/spec/`, enforced by `pnpm docs:check`. The specification tree now
holds roughly 4.5 MB of English text, so the mirror doubled the documentation
that every behavior change had to edit.

## Decision

The Chinese site keeps only its orientation entry points:

- `zh-CN/index.md` (home), `zh-CN/guide/*` (guides),
  `zh-CN/plugin-development.md` (plugin authoring), `zh-CN/adr/index.md` (ADR
  map), and `zh-CN/spec/README.md` (specification index).
- Every other specification and ADR page is English only.
- `check-locales.mjs` requires the specification index and the plugin guide
  mirrors.
- The VitePress sidebar for the Chinese specification index lists the English
  specification pages.

## Consequences

- A behavior-changing English specification edit no longer requires a Chinese
  companion edit.
- Chinese readers move to English at the specification detail level, the
  trade-off ADR 0079 rejected; the maintenance cost now outweighs it.
- Removed Chinese pages remain available in git history.

## Alternatives considered

- Keep the full mirror: preserves Chinese reading of every page, at the cost of
  doubling every specification edit and sustaining stale translations.
- Remove the Chinese locale entirely: drops the localized orientation, guides,
  and plugin guide that Chinese users and plugin authors rely on.
