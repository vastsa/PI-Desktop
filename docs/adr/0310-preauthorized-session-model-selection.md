# ADR 0310: Separate Preauthorized Session Model Selection

- Status: Proposed (implementation candidate; not released)
- Related: ADR 0208, [plugin permissions matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

`desktop.control` permits plugins to request `session/configure`, which can also
change tool permission mode. ADR 0208 correctly requires native consent on every
plugin call to this dangerous operation. Remote model selection cannot use this
path unattended, but removing native consent would silently enlarge the authority
of every plugin already granted `desktop.control`.

## Decision

Add `session.model.configure`, a separate high-risk plugin permission requiring
explicit approval at install/update. A plugin with both that permission and
`desktop.control` may invoke the plugin-only `session/configureModel` operation
with `[sessionId, { providerId, modelId, thinkingLevel? }]`. The operation is
not in the external MCP catalog. The gateway validates the operation and
origin; the IPC handler validates the shape again; host-core accepts only those
four named RPC fields, requires the thinking level to be one of its published
values, verifies the provider is enabled and its model is configured, and
writes the model columns plus, when requested, the thinking-level column in one
host-owned update. Existing Plan/active-turn configuration guards remain.
Session mode and tool permission mode are not covered.

`session/configure` retains its dangerous classification and per-call native
consent; neither existing grants nor old plugin installations automatically gain
the new permission. An upgraded plugin must be reviewed with its new manifest
permission. Unupgraded hosts cannot service the new operation, so plugins may
retain the explicitly confirmed legacy path until the new host is deployed.

## Consequences

The new permission allows switching any local session's model and thinking level
without further native prompts; subsequent turns may be sent to that provider and
incur cost, and a higher thinking level can raise token use. The permission does
not grant a model key, transcript read, tool approval, session mode, or
permission-mode change. Revoking the plugin grant immediately disables future
selection calls. This change requires a compatible host build and separate user
approval of the updated plugin, and has no effect on a currently installed older
desktop build.
