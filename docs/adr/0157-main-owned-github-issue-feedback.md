# ADR 0157: Main-owned GitHub issue feedback

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D120, D313, ADR 0022

## Context

Bug reports without an app version, OS, or reproduction steps cannot be triaged, and
although Settings → Info shows version and logs, users had no in-app path to GitHub
issue creation while the issue forms treated those fields as optional.

## Decision

1. GitHub issue forms are the only intake path (`blank_issues_enabled: false`). The
   bug form requires a description, reproduction steps, expected and actual behavior,
   app version, and OS.
2. Settings → Info exposes one **Report a problem** row invoking the allowlisted
   `pi-desktop/app/openFeedback` channel. Electron Main builds a fixed GitHub
   bug-form URL, prefills `app-version`, `os`, and `environment` from Main-owned
   version info, and opens it with `shell.openExternal`; the renderer supplies no URL.
3. The URL must stay on
   `https://github.com/vastsa/PI-Desktop/issues/new?template=bug_report.yml`; feature
   requests stay in GitHub's template picker.

## Consequences

Triage data is collected at intake, opening GitHub follows the same Main-owned URL
rule as the releases page, and no host, storage, or feed contract changes.

## Alternatives

- Renderer `window.open`: the sandbox would choose the destination.
