# ADR 0324: Make Composer Prompt Enhancement an Optional Plugin

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR 0121

## Context

Prompt enhancement was implemented as host-owned UI, settings, IPC, and a
provider completion path. It is useful but optional product behavior; keeping it
in the host makes every user carry a specialized feature and couples Composer to
its settings and runtime logic.

## Decision

- Remove the host-owned prompt-enhancement UI, Settings card, direct enhancement
  IPC, MCP action, and dedicated completion implementation.
- Add `contributes.composerTransforms`, `onComposerTransform`, and the explicit
  `composer.transform` permission to the Plugin SDK.
- Send only the draft text and optional current model key to the plugin.
- Keep prompt enhancement in the separate `vastsa/pi-prompt-enhancement`
  repository.
- On the first load of `pi.prompt-enhancement`, copy valid legacy model,
  thinking, and enabled custom-template values into unset plugin settings before
  `onLoad`.

## Consequences

- Users without the plugin no longer see or carry the enhancement action or
  settings surface.
- The Plugin SDK and manifest gain an additive contribution and permission; no
  plugin manifest schema version or host-core database schema changes.
- Plugins receiving `composer.transform` can see the draft only when their
  action is explicitly invoked.
- Legacy prompt-enhancement values remain stored and config-syncable until
  migration.
- A plugin release that uses the new contribution must declare a compatible
  `engines.piDesktop` range; older hosts cannot display or invoke it.

## Alternatives considered

- Keep the host implementation and publish a second plugin: rejected because
  users would still receive the feature by default and the host and plugin could
  drift into two enhancement paths.
- Use a renderer slot callback: rejected because the transform needs an isolated
  plugin-process handler and a bounded, audited host invocation; a renderer
  module runs in the host document and is a different trust surface.
- Send session history or attachment data for better context: rejected because
  the feature rewrites the current draft and does not need those capabilities.
- Delete the old settings immediately: rejected because users need them for
  first-install migration and because keeping them supports downgrade and
  configuration rollback.
