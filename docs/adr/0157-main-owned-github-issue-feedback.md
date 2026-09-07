# ADR 0157: Main-owned GitHub issue feedback

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D120, D313, ADR 0022

## Context

Bug reports without an app version, OS, or reproduction steps cannot be
triaged. Settings → Info already shows version and logs, but users had no
in-app path to GitHub issue creation, and the existing issue forms treated
those triage fields as optional.

## Decision

1. GitHub issue forms are the only intake path (`blank_issues_enabled: false`).
   The bug form requires a description, reproduction steps, expected and
   actual behavior, app version, and OS. The feature form requires a problem
   and a proposed change. English is the source label language; Chinese
   remains on the same fields.
2. Settings → Info exposes one **Report a problem** row. Its action invokes
   the allowlisted `pi-desktop/app/openFeedback` channel. Electron Main builds
   a fixed GitHub bug-form URL, prefills `app-version`, `os`, and
   `environment` from Main-owned version info, and opens it with
   `shell.openExternal`. The renderer cannot supply a URL.
3. The constructed URL must stay on `https://github.com/vastsa/PI-Desktop/issues/new`
   with `template=bug_report.yml`. Feature requests remain available from
   GitHub's template picker, not from a second Settings action.

## Consequences

- Triage data is collected at intake instead of in follow-up comments.
- Opening GitHub follows the same Main-owned URL rule as the releases page.
- No host-protocol, storage, or update-feed change.

## Alternatives

- Renderer `window.open` of a constructed URL: rejected because it would let
  the sandbox choose the destination, unlike `updates/openReleases`.
- Opening the template chooser without prefilling version: rejected because
  the Settings row already has authoritative version info.
