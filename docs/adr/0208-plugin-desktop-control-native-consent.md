# ADR 0208: Plugin Desktop Control Requires Native User Consent

- Status: Accepted
- Date: 2026-09-10
- Decision: D377
- Related: ADR 0203 (local MCP control plane), D370, D372,
  [07-plugins/03-plugin-api.md](../spec/07-plugins/03-plugin-api.md),
  [07-plugins/04-plugin-security.md](../spec/07-plugins/04-plugin-security.md) §8.2,
  [07-plugins/13-plugin-permissions-matrix.md](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

`desktop.control` gives a plugin the reviewed operation catalog that the local
MCP control plane exposes: project, session, Agent, and workspace operations,
each tagged `read`, `write`, or `dangerous`. The catalog and the invocation
path are shared with MCP so there is one permission and persistence
implementation.

The shared controller requires `confirm: true` for a `dangerous` operation.
For an external MCP agent that flag is the documented contract: it is an
acknowledgement by the agent, not a desktop prompt (D372). When the same
controller is reached from plugin code, the flag is set by the plugin, so a
plugin with `desktop.control` could delete sessions, switch a session to
`auto` tool approval, or resolve a pending tool permission with no human in
the loop. A conversational plugin that shows its own confirmation card is
self-policing, and the card can only show what the plugin (or a model behind
it) chooses to display.

## Decision

1. A `dangerous` desktop operation from a plugin needs two answers. The
   plugin's `confirm: true` remains required first (`CONFIRMATION_REQUIRED`
   otherwise) so an unacknowledged call never reaches the user.
2. After that, Electron main asks the user in a native, blocking dialog
   (`plugin-desktop-consent.ts`) attached to the main window. The dialog
   shows the catalog operation id, the catalog description, and a bounded
   preview of the arguments. It never shows plugin- or model-authored text,
   so a prompt-injected transcript cannot relabel `session/delete` as
   something benign.
3. Escape, dismissal, and Deny are refusals (`PERMISSION_DENIED`). The
   answer is per call; there is no "allow until quit" for dangerous
   operations.
4. A host that supplies no dialog service (headless or test runtime)
   refuses every dangerous operation from plugins. `read` and `write`
   operations are unchanged.
5. Every invocation is audited with plugin id, operation, and risk; a
   refusal is audited as `PERMISSION_DENIED`.
6. `ui.microphone` stays a separate, narrower grant: audio capture only,
   inside the plugin's isolated panel session; camera and other device
   permissions remain denied.

## Consequences

- Plugin-originated destructive desktop operations gain the same
  human-in-the-loop guarantee that plugin file access outside the manifest
  scope already has (`confirmFsAccess`).
- The MCP contract is unchanged: an external agent still acknowledges with
  `confirm: true` and the desktop user is the one who enabled the loopback
  control plane.
- Plugin authors must expect a native prompt and should not promise
  unattended dangerous operations.
- Covered by `apps/desktop/test/plugin-desktop-control.test.mjs` and E2E-236.
