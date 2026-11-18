# ADR 0099: Add titled visual clusters to the Settings directory

- Status: Accepted
- Date: 2026-08-18
- Related: D238, D241, ADR 0096

## Context

The Settings rail is a flat, searchable directory of eight destinations whose
unbroken list is visually dense, and the previous visual-only spacing used divider
lines that were easy to lose against the dark rail and named nothing.

## Decision

The destination index stays flat and keeps its order, IDs, search behavior, and
ownership; four localized, non-interactive headings are rendered above the
existing row clusters, with muted typography and whitespace instead of dividers:

- Personal / 个人: Basics, AI, Shortcuts
- Agent / 智能体: Instructions, Model configuration
- Workspace / 工作区: Import, Project archive
- About / 关于: Info

Search still filters one flat index, and a cluster and its heading disappear when
no destination remains in it.

## Consequences

- The rail gains scan landmarks without another interactive navigation level, in
  both supported UI locales.
- Grouping no longer depends on border contrast, and destination ordering and
  deep-link behavior stay stable.

## Alternatives

- Use divider lines between groups: low-salience in dark mode and they name
  nothing.
- Add interactive nested navigation: the groups own no additional state.
