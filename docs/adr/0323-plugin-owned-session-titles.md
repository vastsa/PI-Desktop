# ADR 0323: Make Session Title Generation a Standalone Plugin

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR 0186
- Amended: 2026-10-08 (D654 restores the deterministic first-prompt fallback)

## Context

The core currently derives a prompt fallback in the renderer and runs a
main-owned one-shot completion after a turn. That couples title policy to the
agent lifecycle and gives users no prompt or model controls. Automatic title
generation is optional behavior and belongs in an independently installable
plugin.

The plugin still needs a safe way to name a normal Desktop session. Existing
plugin session reads are limited to sessions imported by that plugin, while the
general transcript API is intentionally too broad for this task.

Removing every automatic write, however, also removed the deterministic label a
new session got from its first prompt. That label costs no model call and makes
an untouched session readable offline, so it stays in the core; only the
model-composed title moves to the plugin.

## Decision

- Keep one deterministic core title path: sending the first prompt into a
  session whose stored title is still a recognized placeholder writes a
  whitespace-collapsed, 48-character fallback through the host's
  `session.deriveTitle`. The host applies it only while the title is still a
  placeholder with the `default` source, so a manual rename or an earlier
  automatic title always wins, and the write never changes `updated_at`.
- The derived text keeps the `default` source. It is not a user choice, so the
  session stays eligible for automatic replacement by an installed plugin.
- Remove the built-in title completion. No title is composed from a model inside
  the core, and no core flow waits on one.
- Provide `session.autoTitle`, a dedicated high-risk permission for a narrow
  first-turn context and a compare-and-set title update. Context contains only
  the first user message and first assistant reply, each bounded, and is
  available only while the title source is `default`.
- Store `title_source` in host-core schema v23. Manual renames set `manual`;
  plugin updates set `generated`; a placeholder or a first-prompt fallback
  remains `default`. The title update compares the exact expected title and
  source so manual changes win races and survive renderer restarts.
- Ship title generation as the standalone `pi-desktop-session-title-plugin`
  repository. The plugin listens for completed turns and uses the existing
  `agent.complete` and `models.list` APIs. Its settings panel exposes an
  editable prompt template, model selection, and thinking level.

## Consequences

- Without the plugin, a new session shows its localized default title until the
  first prompt derives a label from it, and keeps that label afterwards.
  Installing and granting the plugin is required for model-composed titles.
- The plugin can customize title policy without adding a second title engine
  inside Electron or the renderer.
- The new permission allows the plugin to see bounded excerpts from any
  active default-titled Desktop session. It does not expose attachments, tools,
  later messages, or a general transcript-read method.
- Schema v23 classifies existing default placeholders as `default` and other
  existing titles as `manual`, preserving user-chosen titles during migration.
- Existing sessions that still hold a known placeholder title receive the
  first-prompt fallback on their next prompt, exactly like a new session.

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
