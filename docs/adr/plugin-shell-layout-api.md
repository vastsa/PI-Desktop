# Plugin shell layout API

- Status: Accepted
- Date: 2026-11-13
- Related: [issue #1997](https://github.com/vastsa/PI-Desktop/issues/1997),
  [Plugin API](../spec/07-plugins/03-plugin-api.md#shell-layout),
  [session-scoped work panel](0028-session-scoped-work-panel-contexts.md)

## Context

Plugins need to inspect the visible sidebar/work panel and activate existing
work-panel tabs. The renderer already owns layout geometry, resize behavior and
session-local tabs. Giving Main a second mutable layout would race user drags
and session changes; treating `ui.view` as shell control would expand an
existing grant.

## Decision

Expose additive `shell.getLayout`, `shell.setSidebar`, `shell.setWorkPanel`,
`workPanel.listTabs`, `workPanel.activateTab` and `shell:layout` on the existing
plugin-process and panel/view bridges. Keep `shell.openExternal` unchanged.
Read APIs and subscriptions expose metadata without a grant. Require the new
medium-risk `ui.shell` grant for setters and tab activation, independently of
`ui.view` and `desktop.control`.

The renderer remains authoritative. A focused Main relay correlates requests,
checks the caller's grant and activation scope, and accepts ordered snapshots
from the current renderer load. Mutations carry the current context identity
and resolve after application; stale contexts, renderer loss and disposal fail
explicitly. Internal snapshots carry the displayed session's project identity:
Main may have changed its workspace before the renderer commits a project
switch, so reads and events are authorized against that snapshot project as
well as the existing current-workspace check. Pending session selection is an
explicit unavailable state. Plugin document reload/crash cancels queued work
even when its WebContents survives.
Subscriptions replay the current snapshot per listener and publish
deduplicated committed changes, including completed drags.

Reuse existing width clamps, persisted preferences and sidebar-reopen geometry.
A hidden panel retains tabs and width; reopening an empty panel creates no tab.
Activation never opens the panel and an unknown tab remains a no-op. The API
does not expose tab contents or background-session control.

## Alternatives

- A mutable Main layout mirror was rejected because it creates competing state
  owners and can acknowledge a layout the renderer has not applied.
- Direct plugin access to renderer internals was rejected because it bypasses
  the authenticated bridge and couples plugins to implementation details.
- Reusing `ui.view` or `desktop.control` was rejected because neither existing
  grant specifically authorizes changing the user's shell layout.

## Consequences

Plugins gain a small public layout interface without changing persistence,
host-core storage or existing grants. The relay must clean up pending work and
listeners across renderer/plugin lifecycles. Width results can differ from
requested widths under the live geometry budget; the regular work-panel
minimum does not override the existing compact sidebar-reopen loan. Older hosts
remain supported through method detection and `UNSUPPORTED` handling. Exact
fields, events and error behavior are specified in the Plugin API, not this ADR.
