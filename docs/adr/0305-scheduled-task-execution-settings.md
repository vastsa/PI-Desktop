# ADR 0305: Keep scheduled-task execution settings task-owned

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: `scheduled-desktop-automations.md`

## Context

Scheduled tasks owned their prompt, cadence, and project binding but not the rest
of their execution configuration: automatic runs always used Ask permission mode
and resolved the app's current default provider/model at start, so editing a
global default could silently change an unrelated task and the Scheduled form
could not move a task to another saved project.

## Decision

Each task's host-owned `config_json` gains optional `permissionMode`,
`providerId`, `modelId`, and `thinkingLevel` beside the existing
`workspacePath`, with provider and model as an all-or-nothing pair. The Scheduled
form reuses the conversation composer's model filtering, aliases, permission
labels, and model/reasoning picker while writing a separate copy to the selected
task, and both Run now and automatic runs create their session from the
task-owned values. Only the trusted desktop management surface may retarget a
task; conversation tools stay scoped to their calling session's project and gain
no project, model, or permission parameters.

Compatibility stays additive: a task without `providerId`/`modelId` keeps
resolving app defaults, a legacy automatic task without `permissionMode` keeps
Ask, a legacy manual task keeps its inherited permission behavior, an
unavailable saved model stays visible and preserved, and a missing
`thinkingLevel` retains `off` without a migration.

## Consequences

- No table migration is needed because `config_json` is the existing extension
  boundary, and older versions ignore the additive fields.
- Selecting Auto is an explicit per-task choice that can run restricted actions
  without approval; Ask remains the default for new and legacy tasks.
- The scheduled-task projection and desktop IPC gain optional fields, so host,
  shared types, renderer, and contract tests change together.

## Alternatives

- Keep global defaults as the only source: one setting change can retarget every
  automation.
- Add physical columns: the validated JSON boundary already owns optional task
  configuration.
