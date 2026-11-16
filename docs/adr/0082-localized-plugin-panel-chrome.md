# ADR 0082: Localized and page-adaptive plugin panel chrome

- Status: Accepted

## Context

A plugin panel's titlebar took a single manifest string and the preload chrome defaulted to
a dark surface, splitting the panel from the active UI language and giving light plugin
pages a black header.

## Decision

`ui.title` accepts the existing string form or a localized object holding both `en` and
`zh-CN`, resolved against the active UI locale and falling back to the other label, then the
manifest name. The host passes the active light/dark theme, and the preload samples the
document's computed body background and foreground for the titlebar, using the host theme
when the page is transparent. The titlebar stays in the closed preload-owned Shadow DOM, so
plugin CSS cannot restyle host controls.

## Consequences

- Authors ship one manifest with English and Simplified Chinese titles, and chrome stays
  coherent with custom pages and the host theme.
- A panel that recolors after first paint is not re-inspected; string manifests and panel
  dimensions stay compatible.
