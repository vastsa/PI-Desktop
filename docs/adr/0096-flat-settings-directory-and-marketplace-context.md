# ADR 0096: Flatten the Settings directory and colocate marketplace source configuration

> Superseded 2026-10-08 for marketplace-source controls: Plugins → Marketplace
> now uses only the official catalog and has no source selector. See the
> amendment to [ADR 0276](0276-official-plugin-channel-and-backup-channels.md).

- Status: Accepted for Settings IA; marketplace-source placement superseded
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D166, D168, D238, ADR 0036, ADR 0058

## Context

The implemented Settings rail had grown to nine entries, including a separate
`Extensions` destination for two marketplace-source controls. The rail also
wrapped destinations in `Personal`, `Integrations`, and an implicit system
section. Those headings repeated information already expressed by the
destination labels, while `Extensions` had the same visible name as the
app-shell destination that owns plugin management.

The settings IA already defines eight useful destinations. Plugin marketplace
source selection is a marketplace concern and belongs beside the catalog it
controls, not beside appearance, providers, or project settings.

## Decision

Keep the full-page Settings shell and render one flat, searchable directory in
this exact order:

1. Basics
2. AI
3. Shortcuts
4. Instructions
5. Model configuration
6. Import
7. Project archive
8. Info

Remove navigation group headings and the Settings `Extensions` destination.
At the time of this decision, move the official/mirror/custom marketplace
source selector, including the custom catalog URL field and active-source
status, into the app-shell `Extensions → Marketplace` surface. That selector
has since been retired: the page now uses the official catalog only, and
host-core ignores legacy source values. The shared Settings search index still
contains only the eight Settings destinations.

No IPC, host protocol, storage, provider, plugin permission, or project
ownership contract changes.

## Consequences

- Settings has one visual hierarchy and fewer competing labels.
- The rail matches the frozen eight-destination IA and no longer duplicates
  the Extensions page name.
- The marketplace-source selector described by this ADR is no longer present;
  source selection is not a Settings destination or an Extensions control.
- Screenshot capture scenes and marketplace E2E steps use the fixed official
  catalog.

## Alternatives

### Keep the three group headings

Rejected because the groups do not add a second useful navigation level; they
make the rail taller and repeat the meaning of the destination labels.

### Rename Settings `Extensions` to `Marketplace`

Rejected because it would preserve a one-card Settings destination and still
split marketplace browsing from marketplace configuration.

### Remove marketplace source configuration

Rejected at the time because mirror and custom catalog sources were considered
necessary for some networks and development catalogs. The later official-only
decision retains the catalog URL fallback and a development environment
override; see ADR 0276.

## References

- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/07-plugins/07-plugin-marketplace.md`
