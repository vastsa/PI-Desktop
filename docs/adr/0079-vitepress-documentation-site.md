# ADR 0079: Use VitePress for the bilingual documentation site

- **Status:** Accepted; the Chinese companion scope is amended by
  [ADR chinese-docs-entry-points-only](chinese-docs-entry-points-only.md)
- **Date:** 2026-08-13

## Context

The repository has a growing set of specifications, ADRs, project notes, and
plugin authoring material. Plain Markdown files are easy to review, but the
current directory has no shared navigation, local search, responsive reading
experience, or clear language entry point.

## Decision

Make `docs/` a standalone VitePress project in the pnpm workspace. Keep the
existing Markdown files in place as the source of truth and add a custom,
responsive theme with local search, English and Simplified Chinese locale entry
points, and curated navigation.

The English site is complete and remains canonical. The Chinese site provides a
translated orientation, topic map, and a complete path-for-path companion for
every specification.

## Consequences

- Contributors can run, build, and preview the docs with `pnpm docs:*` commands.
- Documentation has a stable static site shape without adding a server runtime.
- New user-visible documentation behavior must be covered in the E2E test plan.
- English remains the canonical language for specs, ADRs, protocol terms, and
  code-facing documentation.
- A behavior-changing English specification edit must update its Chinese
  companion in the same logical change.

## Alternatives considered

- Keep plain Markdown only: preserves the smallest toolchain, but does not solve
  navigation, search, responsive presentation, or bilingual entry points.
- Translate only orientation and topic landing pages: lowers maintenance cost,
  but makes Chinese navigation switch back to English precisely when a reader
  reaches the technical detail and leaves locale coverage impossible to verify.
- Use a hosted docs platform: adds an external publishing dependency and makes
  local preview less representative of the repository source.
