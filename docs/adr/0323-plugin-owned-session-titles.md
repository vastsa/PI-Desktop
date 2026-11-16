# ADR 0323: Make Session Title Generation a Standalone Plugin

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR 0186
- Amended: 2026-10-08 (D654 restores the deterministic first-prompt fallback)
- Amended: 2026-10-20 (ADR 0340 adds `session.read.all`, so the rejected
  "give the plugin a broader session read" alternative below no longer fails
  for the reason recorded here)

## Context

The core currently derives a prompt fallback in the renderer and runs a
main-owned one-shot completion after a turn. That couples title policy to the
agent lifecycle and gives users no prompt or model controls.

## Decision

- Keep one deterministic core title path: sending the first prompt into a
  session whose stored title is still a recognized placeholder writes a
  whitespace-collapsed, 48-character fallback through the host's
  `session.deriveTitle`.
- The derived text keeps the `default` source.
- Remove the built-in title completion.
- Provide `session.autoTitle`, a dedicated high-risk permission for a narrow
  first-turn context and a compare-and-set title update.
- Store `title_source` in host-core schema v23. Manual renames set `manual`;
  plugin updates set `generated`; a placeholder or a first-prompt fallback
  remains `default`.
- Ship title generation as the standalone `pi-desktop-session-title-plugin`
  repository.

## Consequences

- Without the plugin, a new session shows its localized default title until the
  first prompt derives a label from it, and keeps that label afterwards.
- The plugin can customize title policy without adding a second title engine
  inside Electron or the renderer.
- The new permission allows the plugin to see bounded excerpts from any active
  default-titled Desktop session.
- Schema v23 leaves pre-existing v22 titles as `legacy` to protect deliberate
  renames from automatic replacement; newly created sessions receive `default`
  or `manual` as appropriate.

## Alternatives considered

- Remove the first-prompt fallback together with the completion: rejected after
  review because readability would then depend on installing an optional plugin,
  and an untouched session would show a placeholder forever.
- Keep the completion in the core: rejected because it would still automatically
  spend model tokens and mutate titles when the optional plugin is absent.
- Give the plugin `session.read` or `session.read.own`: rejected because those
  permissions either expose a general transcript projection or only imported
  sessions and do not match the required boundary.
- Run a second title flow in Electron main: rejected because title policy and
  user-configured prompts/models belong to the plugin after this change.
