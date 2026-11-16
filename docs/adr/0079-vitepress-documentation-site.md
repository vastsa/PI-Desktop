# ADR 0079: Use VitePress for the bilingual documentation site

- Status: Accepted
- Date: 2026-08-13

## Context

`docs/` holds specifications, ADRs, project notes, and plugin authoring material
as plain Markdown. Review stays easy, but readers get no shared navigation, local
search, responsive reading layout, or language entry point.

## Decision

Make `docs/` a standalone VitePress project in the pnpm workspace, keeping the
Markdown files as the source of truth and adding a responsive custom theme with
local search, English and Simplified Chinese entry points, and curated
navigation. English stays canonical; the Chinese site provides a translated
orientation, a topic map, and a path-for-path companion for every specification,
preserving code and protocol identifiers, linking back to the English source, and
sharing the generated sidebar so coverage gaps are detectable. One centered
layout serves landing, guide, specification, ADR, project, and plugin pages, with
reading width bounded independently of the sidebar and outline rails.

## Consequences

- Contributors preview and build docs with `pnpm docs:*`; VitePress becomes a
  development dependency of a new workspace package.
- Documentation gets a static site shape without adding a server runtime.
- A behavior-changing English specification edit updates its Chinese companion in
  the same change.

## Alternatives

- Keep plain Markdown only: rejected because it solves none of navigation, search,
  or bilingual entry.
- Hosted docs platform: rejected because it adds an external publishing
  dependency and makes local preview less representative.
