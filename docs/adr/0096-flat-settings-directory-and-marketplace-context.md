# ADR 0096: Flatten the Settings directory and colocate marketplace source configuration

> Superseded 2026-10-08 for marketplace-source controls: Plugins → Marketplace
> now uses only the official catalog and has no source selector. See the
> amendment to [ADR 0276](0276-official-plugin-channel-and-backup-channels.md).

- Status: Accepted for Settings IA; marketplace-source placement superseded
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D166, D168, D238, ADR 0036, ADR 0058

## Context

The Settings rail had grown to nine entries, including a separate `Extensions`
destination for two marketplace-source controls, and wrapped destinations in
`Personal`, `Integrations`, and an implicit system section. Those headings repeated
what the labels already said, while `Extensions` carried the same visible name as the
app-shell destination that owns plugin management.

## Decision

Keep the full-page Settings shell and render one flat, searchable directory in this
order: Basics, AI, Shortcuts, Instructions, Model configuration, Import, Project
archive, Info. Remove the navigation group headings and the Settings `Extensions`
destination.

The official/mirror/custom marketplace source selector, including the custom catalog
URL field and active-source status, moved into the app-shell
`Extensions → Marketplace` surface. That selector has since been retired: the page
uses the official catalog only, host-core ignores legacy source values, and the
shared Settings search index contains only the eight destinations. No IPC, host
protocol, storage, provider, plugin permission, or project ownership contract
changes.

## Consequences

- Settings has one visual hierarchy, the rail matches the frozen eight-destination
  IA, and it no longer duplicates the Extensions page name.
- Marketplace source selection is neither a Settings destination nor an Extensions
  control; capture scenes and E2E steps use the fixed official catalog.

## Alternatives

- Keep the three group headings: they add no second useful level and repeat the
  labels.
- Rename Settings `Extensions` to `Marketplace`: it preserves a one-card destination
  and still splits browsing from configuration.
- Remove source configuration: rejected at the time; the official-only decision keeps
  the catalog URL fallback and a development override (ADR 0276).
