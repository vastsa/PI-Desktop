# ADR: Docked views can accept transcript selections

- Status: Accepted
- Date: 2026-11-19
- Related: ADR 0104, ADR 0268, GitHub #2395

## Context

A plugin can open its own docked view, but it has no menu item for an excerpt
selected in the transcript. The user should be able to choose where one
excerpt goes from the message menu.

## Decision

A contributed docked view can opt into the transcript selection menu with
`acceptsTranscriptSelection`. The host draws the view's localized title and
existing icon token. A user click opens that view and delivers the excerpt
and active session ID in a one-way `view:selection` event. The host keeps
pending excerpts in memory until the target view finishes loading.

## Consequences

This extends the work-panel view contract. It leaves the retired native quote
and side-chat actions out of the host. An opt-in requires the existing
`ui.view` grant and project activation. It does not give a plugin a selection
reader, inject executable UI, expose the full message, or grant session or
Composer write access.

## Alternatives

Putting the excerpt in the view's existing location would expose text in its
URL and replay it on reload. A renderer extension would require a broader
permission for a host-rendered menu item.
