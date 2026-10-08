# ADR 0324: Make Composer Prompt Enhancement an Optional Plugin

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR 0121

## Context

Prompt enhancement was implemented as host-owned UI, settings, IPC, and a
provider completion path. It is useful but optional product behavior; keeping
it in the host makes every user carry a specialized feature and couples
Composer to its settings and runtime logic. Users asked for the feature to live
in a separate repository and require an explicit install, with existing
preferences migrated when they install it.

The host needs a narrow extension point that lets a plugin transform a draft
without receiving the conversation transcript, attachment data, or local file
paths. The extension must preserve draft and session race safety and keep the
plugin behind the existing permission and audit boundaries.

## Decision

- Remove the host-owned prompt-enhancement UI, Settings card, direct enhancement
  IPC, MCP action, and dedicated completion implementation.
- Add `contributes.composerTransforms`, `onComposerTransform`, and the explicit
  `composer.transform` permission to the Plugin SDK. The host displays actions
  only for loaded plugins with a current grant and invokes them only after a
  user action.
- Send only the draft text and optional current model key to the plugin. Strip
  inline file-reference markers before dispatch and restore them after a
  successful transform. Enforce a 100,000-character input/output limit, the
  plugin tool timeout, manifest declaration checks, permission checks, and
  call auditing. Return text to the Composer with one-step undo and stale-draft
  and stale-session protection.
- Keep prompt enhancement in the separate `vastsa/pi-prompt-enhancement`
  repository. The host neither bundles nor enables it by default; a user must
  install it and grant its declared permissions. The plugin owns its settings
  and its model request, using separately granted plugin APIs as needed.
- On the first load of `pi.prompt-enhancement`, copy valid legacy model,
  thinking, and enabled custom-template values into unset plugin settings
  before `onLoad`. Write a private one-time marker, leave existing plugin
  values authoritative, skip invalid or inactive templates, and preserve the
  old host settings for rollback and downgrade compatibility.

## Consequences

- Users without the plugin no longer see or carry the enhancement action or
  settings surface. Installing the plugin is the opt-in boundary.
- The Plugin SDK and manifest gain an additive contribution and permission;
  no plugin manifest schema version or host-core database schema changes.
- Plugins receiving `composer.transform` can see the draft only when their
  action is explicitly invoked. They do not receive session identity, history,
  attachments, or paths. Plugins that call a model request additional
  permissions independently.
- Legacy prompt-enhancement values remain stored and config-syncable until
  migration. The host does not use them as active settings after migration.
- A plugin release that uses the new contribution must declare a compatible
  `engines.piDesktop` range; older hosts cannot display or invoke it.

## Alternatives considered

- Keep the host implementation and publish a second plugin: rejected because
  users would still receive the feature by default and the host and plugin
  could drift into two enhancement paths.
- Use a renderer slot callback: rejected because the transform needs an
  isolated plugin-process handler and a bounded, audited host invocation; a
  renderer module runs in the host document and is a different trust surface.
- Send session history or attachment data for better context: rejected because
  the feature rewrites the current draft and does not need those capabilities.
- Delete the old settings immediately: rejected because users need them for
  first-install migration and because keeping them supports downgrade and
  configuration rollback.
