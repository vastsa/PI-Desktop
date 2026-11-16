# ADR: Retain a host-owned browser page per resource tab

- Status: Accepted
- Date: 2026-09-26
- Supersedes: ADR 0170 clause 6 (singleton guest)

## Context

Browser resource tabs initially retained addresses but shared one guest.
Switching reloaded pages and discarded form/scroll/JavaScript state.

## Decision

Electron Main's BrowserHost owns pages keyed by session id and tab id. Each page
owns its BrowserPane, CDP state, navigation generation, and current browser
state.

BrowserPreview validates the request and asks BrowserHost to create and load a
new resource page before its renderer tab mounts. Background browser.navigate
runs immediately in its session's connected page.

## Alternatives

Keeping one guest and saving only URLs cannot preserve live page state.

## Consequences

Normal tab switching preserves forms, scroll position and per-tab navigation
history without issuing another load.
