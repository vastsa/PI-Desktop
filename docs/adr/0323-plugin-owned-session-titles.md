# ADR 0323: Make Session Title Generation a Standalone Plugin

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR 0186
- Amended: 2026-10-08 (D654 restores the deterministic first-prompt fallback)
- Amended: 2026-10-20 (ADR 0340 adds `session.read.all`, so the rejected "give
  the plugin a broader session read" alternative below no longer fails for the
  reason recorded here)

## Context

Core derived a prompt fallback in the renderer and ran a main-owned one-shot
completion after a turn, which coupled title policy to the agent lifecycle and
gave users no prompt or model controls. The plugin still needs a safe way to name
a normal Desktop session, and removing every automatic write also removed the
deterministic label a new session got from its first prompt.

## Decision

One deterministic core title path stays: sending the first prompt into a session
whose stored title is still a recognized placeholder writes a whitespace-collapsed
48-character fallback through `session.deriveTitle`, applied only while the title
is still a placeholder with the `default` source and without touching
`updated_at`. The built-in model completion is removed, so no core flow waits on a
composed title.

`session.autoTitle` is a dedicated high-risk permission granting a narrow
first-turn context — the bounded first user message and first assistant reply,
available only while the source is `default` — plus a compare-and-set title
update. Host-core schema v23 stores `title_source`, where a manual rename sets
`manual`, a plugin update sets `generated`, and a placeholder or fallback stays
`default`, so a manual change wins races and survives renderer restarts.

Title generation ships as the standalone `pi-desktop-session-title-plugin`, which
listens for completed turns and uses the existing `agent.complete` and
`models.list` APIs, with settings for an editable prompt template, model
selection, and thinking level.

## Consequences

- Without the plugin, a new session shows its localized default title until the
  first prompt derives a label, and keeps that label afterwards.
- Title policy is customizable without a second title engine in Electron or the
  renderer.
- The permission exposes bounded first-turn excerpts from default-titled sessions
  and nothing else, and pre-existing v22 titles become `legacy` to protect
  deliberate renames.

## Alternatives considered

- Remove the first-prompt fallback with the completion: rejected; readability
  would then depend on an optional plugin.
- Keep the completion in core: rejected; it would spend model tokens and mutate
  titles whenever the plugin is absent.
