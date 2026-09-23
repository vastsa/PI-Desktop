# ADR 0305: Keep scheduled-task execution settings task-owned

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: `scheduled-desktop-automations.md`

## Context

Scheduled tasks already own their prompt, cadence and project binding, but they
did not own the rest of their execution configuration. Automatic runs always
used Ask permission mode and resolved the app's current default provider/model
when each run started. Editing a global default could therefore change an
unrelated saved task, and the Scheduled form could not move a task to another
saved project.

The conversation composer already defines the supported permission choices and
the configured provider/model catalog. Scheduled tasks should use those same
choices without sharing mutable draft or session state with a conversation or
another task.

## Decision

Store optional `permissionMode`, `providerId` and `modelId` fields alongside the
existing `workspacePath` in each task's Host-owned `config_json`. Provider and
model are an all-or-nothing pair. The Scheduled form uses the same configured
model filtering, aliases and permission labels as the conversation composer,
but writes a separate copy to the selected task.

New tasks default to the current project, Ask permission mode and the current
default provider/model when those values exist. Users may explicitly choose
another saved project, permission mode or configured model. Both Run now and
automatic runs create their session from the task-owned values.

Compatibility remains additive:

- a task without `providerId`/`modelId` continues to resolve the app defaults at
  run time;
- a legacy automatic task without `permissionMode` continues to use Ask;
- a legacy manual task without `permissionMode` keeps its previous inherited
  permission behavior;
- existing workspace-capture and project-removal rules remain unchanged;
- an unavailable saved model remains visible and preserved instead of silently
  changing to another model.

Only the trusted desktop management surface may retarget a task. Conversation
tools remain scoped to their calling session's project and do not gain project,
model or permission parameters.


Tasks also persist optional `thinkingLevel` using the existing session values
(including `off` and `omit`). The full Composer model/reasoning picker and
controller are reused with a task-draft configuration callback. Both manual and
automatic runs apply the saved level. Missing or cleared levels retain the
legacy `off` behavior; no database migration is required.

## Consequences

No table migration is required because `config_json` is the existing extension
boundary. Older versions ignore the additive fields and fall back to their
previous execution behavior. Selecting Auto is an explicit per-task choice and
can run restricted actions without waiting for approval; Ask remains the default
for new and legacy automatic tasks.

The public scheduled-task projection and desktop IPC gain optional fields, so
Host, shared types, renderer and contract tests must change together.

## Alternatives

Keeping global defaults as the only source was rejected because changing one
setting can retarget every automation. Adding physical columns was rejected
because the existing validated JSON boundary already owns optional task
configuration. Backfilling old rows was rejected because it would turn their
dynamic default behavior into a fixed selection during upgrade.

