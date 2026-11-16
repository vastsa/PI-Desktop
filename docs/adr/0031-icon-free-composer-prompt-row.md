# ADR 0031: Keep composer prompt rows free of brand icons

- Status: Accepted
- Date: 2026-07-28
- Related: D054, D094, D160

## Context

D054 and D094 put the canonical PI-Desktop logo beside an empty draft in the
thread-docked composer while the home composer dropped the cue, so the two prompt
rows disagreed and the leftover mark spent input width on no navigation, status,
or runtime meaning.

## Decision

Home and thread-docked prompt rows render no leading brand icon, and draft text
and placeholder ink start at the input row's standard content gutter with no
reserved space. The renderer `BrandLogo` component keeps the canonical asset for
the home hero, sidebar, splash, Dock, application menu, and About identity, and
session-creation controls keep their message-plus icon. This supersedes only
D054's leading brand cue and D094's docked-composer logo placement; naming and
the remaining brand-asset requirements are unchanged.

## Consequences

- Home and transcript composers share one icon-free prompt-row boundary.
- The textarea gains the width the logo and its gap took.
- Brand recognition moves to the surrounding shell, not a text-entry surface.

## Alternatives

- Keep the docked logo: preserves inconsistent input-row anatomy for no state or
  action.
- Add the logo to the home composer: repeats decorative chrome in both
  text-entry surfaces.
