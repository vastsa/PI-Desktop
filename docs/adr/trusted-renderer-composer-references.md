# ADR: Trusted renderer entries for composer references

- Status: Accepted for implementation
- Date: 2026-09-20
- Scope: Issue #545 slots 7 and 14; session-reference example for #446

## Context

Completion providers need asynchronous search and reference resolution. Functions
cannot cross the existing process boundary. Running session-reference logic in
the composer would make one plugin's data source part of the desktop application.

## Decision

Add an optional `manifest.renderer` ES-module entry, alongside the existing
process-isolated `main` and page-based views. A renderer entry executes in the
application's JavaScript realm. Declaring the entry derives the high-risk
`ui.renderer` trust grant shown by installation and development-load review.
Authors do not declare per-slot permissions. Existing entries retain their
permission and process boundaries.

The first renderer contract exposes data-producing completion providers and
reference lifecycle callbacks. The host renders these two slots. Arbitrary
React component slots, a React shim, and plugin styles are separate work;
this implementation does not claim the other twelve slots in #545.

Use one reference identity, `(pluginId, refId)`, for completion acceptance and
active insertion. Resolve each reference independently when the user submits a
message. Persist the expanded model content with separate, optional display
metadata. SQLite schema 20 adds a nullable display field to queued turns;
transcript JSONL stores the same additive metadata. Existing rows require no
content rewrite. A missing or failing plugin leaves its literal label intact.

## Alternatives

- Built-in session mentions: avoids the renderer loader but places plugin-specific
  history selection in the host and provides no reusable extension point.
- Isolated-page RPC: preserves isolation but does not establish the renderer
  execution model selected by #545. It remains the model for existing views.
- Encoded hidden text inside message content: avoids a queue column but makes
  user text double as a display protocol and can hide ordinary pasted text.

## Consequences

Trusted renderer code can access the DOM and the renderer's application APIs.
The narrow SDK is an integration contract, not a security sandbox. Infinite
synchronous loops cannot be interrupted by a promise timeout. The host bounds
entry size, asynchronous activation/search/resolution, clears registrations on
unload and project changes, and displays activation diagnostics in plugin details.

Renderer entries must be self-contained bundles. The entry path is checked
against the real package directory; theme assets do not gain script execution.
The CSP permits blob modules for the reviewed source returned by the host.

Native Pi continuation and remote hosts reject composer-reference payloads until
their transports can preserve the display metadata. The editor restores rejected
drafts. Schema 20 databases cannot be reopened by older builds that support only
schema 19; the upgrade takes the standard migration backup.
