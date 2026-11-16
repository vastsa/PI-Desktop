# ADR 0324: Make Composer Prompt Enhancement an Optional Plugin

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR 0121

## Context

Prompt enhancement shipped as host-owned UI, settings, IPC, and a provider
completion path, so every user carried a specialized feature and the Composer
stayed coupled to its settings and runtime logic. Users asked for it in a
separate repository behind an explicit install, and the host still needs a
narrow way to let a plugin transform a draft without receiving the transcript,
attachments, or local paths.

## Decision

Remove the host-owned enhancement UI, Settings card, direct IPC, MCP action, and
completion path, and add `contributes.composerTransforms`, `onComposerTransform`,
and the explicit `composer.transform` permission to the Plugin SDK, with actions
shown only for loaded plugins holding a current grant and invoked only after a
user action. Dispatch sends only the draft text and optional model key, strips
inline file-reference markers before the call and restores them after a
successful transform, enforces the input/output limit, plugin tool timeout,
manifest and permission checks, and call auditing, and returns text with
one-step undo plus stale-draft and stale-session protection. The feature lives
in the separate `vastsa/pi-prompt-enhancement` repository, which the host
neither bundles nor enables, and the first load of `pi.prompt-enhancement`
copies valid legacy model, thinking, and enabled custom-template values into
unset plugin settings behind a private one-time marker while keeping existing
plugin values authoritative and the old host settings for rollback.

## Consequences

- Users without the plugin no longer see the action or its settings surface.
- The SDK and manifest gain an additive contribution and permission, with no
  manifest schema version or database schema change.
- A plugin sees the draft only when its action is invoked, never session
  identity, history, attachments, or paths, and a plugin release using the
  contribution must declare a compatible `engines.piDesktop` range.

## Alternatives

- Keep the host implementation and also publish a plugin: rejected, users would
  still receive it by default and two enhancement paths could drift.
- A renderer slot callback: rejected, the transform needs the isolated plugin
  process and a bounded, audited host invocation.
