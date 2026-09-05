# ADR 0158: Keep approval cards focused and remember the selected mode

- Status: Accepted for implementation
- Date: 2026-08-12
- Deciders: PI-Desktop core
- Amends: D189 · ADR 0053
- Related: D215 · E2E-106

## Context

The Plan/Goal approval card duplicated the submitted question, status, and
deadline alongside the artifact opener. The approval mode also reset to Ask for
every proposal, even when the user had just chosen a different mode.

Plan artifact filenames were title-derived for ASCII titles but fell back to a
generic `plan`/`goal` stem for non-ASCII titles, making localized workspaces
harder to scan.

## Decision

1. The pending approval card renders only the proposal title, the host-created
   artifact path/open action, Reject, and the Approve split-button. Question or
   description text, status, validity/deadline, and inline safety warning are
   not card content.
2. Selecting Ask, Accept edits, or Auto stores that choice in renderer-local
   device preferences. Each later approval uses the stored choice as its
   default; Ask remains the fallback when storage is unavailable or invalid.
3. Host-generated artifact filenames preserve alphanumeric Unicode title
   characters, normalize separators to hyphens, and retain the timestamp and
   collision suffix. Path validation continues to accept only the generated
   safe filename shape under `.pi/<kind>/`.
4. The existing host approval deadline remains an internal compatibility and
   fail-closed boundary; it is no longer exposed as an approval-card concept.

## Consequences

- The card is compact and keeps attention on the decision and the reviewable
  artifact.
- Users who routinely approve with Auto or Accept edits do not repeat that
  selection for every proposal on the same device.
- Localized titles produce recognizable artifact names while preserving unique,
  host-owned immutable files.
- The wire/storage contract remains compatible; legacy deadline data is not
  presented by the renderer.

## Alternatives considered

### Persist the choice in the host settings table

Rejected for this change. The choice is a renderer UI preference, and adding it
to host settings would expand the protocol and settings ownership boundary for
no additional approval safety.

### Keep the question and deadline in a collapsed card section

Rejected. The requested approval surface is intentionally limited to title,
artifact review, and the two decisions; the full Markdown remains available by
opening the host-created file.
