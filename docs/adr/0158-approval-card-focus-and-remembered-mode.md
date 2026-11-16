# ADR 0158: Keep approval cards focused and remember the selected mode

- Status: Accepted for implementation
- Date: 2026-08-12
- Amends: D189 · ADR 0053
- Related: D215 · E2E-106

## Context

The Plan/Goal approval card repeated the question, status, and deadline beside
the artifact opener, reset the approval mode to Ask for every proposal, and
derived artifact filenames fell back to a generic `plan`/`goal` stem for
non-ASCII titles.

## Decision

The pending card renders only the proposal title, the host-created artifact path
and open action, Reject, and the Approve split-button. Choosing Ask, Accept
edits, or Auto stores that choice in renderer-local device preferences as the
default for later approvals, with Ask as the fallback when storage is unavailable
or invalid, and generated filenames keep alphanumeric Unicode title characters,
normalize separators to hyphens, and retain the timestamp and collision suffix
under `.pi/<kind>/`. The host approval deadline stays an internal fail-closed
boundary rather than card content.

## Consequences

- The card stays compact and keeps attention on the decision and the artifact.
- Auto and Accept edits users do not reselect a mode per proposal on a device.
- Localized titles yield recognizable names while files stay host-owned; the
  wire and storage contract is unchanged.

## Alternatives considered

- Persist the mode in host settings: rejected; it is a renderer preference and
  would widen the protocol boundary.
- Keep a collapsed question and deadline section: rejected; the full Markdown is
  reachable through the host-created file.
