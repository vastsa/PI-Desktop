# ADR 0323: Make Session Title Generation a Standalone Plugin

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR 0186

## Context

The core currently derives a prompt fallback in the renderer and runs a
main-owned one-shot completion after a turn. That couples title policy to the
agent lifecycle and gives users no prompt or model controls. Automatic title
generation is optional behavior and belongs in an independently installable
plugin.

The plugin still needs a safe way to name a normal Desktop session. Existing
plugin session reads are limited to sessions imported by that plugin, while the
general transcript API is intentionally too broad for this task.

## Decision

- Remove core prompt-derived fallback titles and the built-in title one-shot.
  New sessions keep their localized default title until the user renames them
  or an installed plugin updates them.
- Provide `session.autoTitle`, a dedicated high-risk permission for a narrow
  first-turn context and a compare-and-set title update. Context contains only
  the first user message and first assistant reply, each bounded, and is
  available only while the title source is `default`.
- Store `title_source` in host-core schema v23. Manual renames set `manual`;
  plugin updates set `generated`; default placeholders remain `default`. The
  title update compares the exact expected title and source so manual changes
  win races and survive renderer restarts.
- Ship title generation as the standalone `pi-desktop-session-title-plugin`
  repository. The plugin listens for completed turns and uses the existing
  `agent.complete` and `models.list` APIs. Its settings panel exposes an
  editable prompt template, model selection, and thinking level.

## Consequences

- Without the plugin, a new session keeps the default title. Installing and
  granting the plugin is required for generated titles.
- The plugin can customize title policy without adding a second title engine
  inside Electron or the renderer.
- The new permission allows the plugin to see bounded excerpts from any
  active default-titled Desktop session. It does not expose attachments, tools,
  later messages, or a general transcript-read method.
- Schema v23 classifies existing default placeholders as `default` and other
  existing titles as `manual`, preserving user-chosen titles during migration.

## Alternatives considered

- Keep the first-prompt fallback in the core: rejected because it would still
  automatically mutate titles when the optional plugin is absent.
- Give the plugin `session.read` or `session.read.own`: rejected because those
  permissions either expose a general transcript projection or only imported
  sessions and do not match the required boundary.
- Run a second title flow in Electron main: rejected because title policy and
  user-configured prompts/models belong to the plugin after this change.
