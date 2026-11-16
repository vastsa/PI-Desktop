# ADR 0208: Plugin Desktop Control Requires Native User Consent

- Status: Accepted
- Date: 2026-09-10
- Related: D370, D372, D377, ADR 0203

## Context

`desktop.control` gives a plugin the reviewed operation catalog of the local MCP
control plane, sharing one permission and persistence implementation with MCP, where
the controller's `confirm: true` is the agent's own acknowledgement (D372). From
plugin code the plugin sets that flag itself, so a holder could delete sessions,
switch a session to `auto` tool approval, or resolve a pending tool permission with
no human in the loop.

## Decision

A `dangerous` desktop operation from a plugin needs two answers: the plugin's
`confirm: true` stays required first (`CONFIRMATION_REQUIRED` otherwise), and
Electron main then asks the user in a native blocking dialog attached to the main
window showing the catalog operation id, its description, and a bounded argument
preview, never plugin- or model-authored text, so an injected transcript cannot
relabel `session/delete`. Escape, dismissal, and Deny are refusals
(`PERMISSION_DENIED`), the answer is per call with no "allow until quit", a host
without a dialog service refuses every dangerous plugin operation, and every
invocation and refusal is audited with plugin id, operation, and risk. `read` and
`write` operations are unchanged, and `ui.microphone` stays a separate narrower
grant for audio capture inside the plugin's isolated panel session.

## Consequences

- Plugin-originated destructive operations gain the human-in-the-loop guarantee that
  out-of-scope plugin file access already has (`confirmFsAccess`).
- The MCP contract is unchanged, so external agents still acknowledge with `confirm:
  true` once the user enables the loopback control plane.
