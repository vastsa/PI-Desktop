# ADR 0305: Keep scheduled-task execution settings task-owned

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: `scheduled-desktop-automations.md`

## Context

Scheduled tasks already own their prompt, cadence and project binding, but they
did not own the rest of their execution configuration. Automatic runs always
used Ask permission mode and resolved the app's current default provider/model
when each run started.

## Decision

Store optional `permissionMode`, `providerId` and `modelId` fields alongside the
existing `workspacePath` in each task's Host-owned `config_json`. Provider and
model are an all-or-nothing pair.

New tasks default to the current project, Ask permission mode and the current
default provider/model when those values exist. Users may explicitly choose
another saved project, permission mode or configured model.

- a task without `providerId`/`modelId` continues to resolve the app defaults at
  run time;
- a legacy automatic task without `permissionMode` continues to use Ask;
- a legacy manual task without `permissionMode` keeps its previous inherited
  permission behavior;
- existing workspace-capture and project-removal rules remain unchanged;
- an unavailable saved model remains visible and preserved instead of silently
  changing to another model.

## Consequences

No table migration is required because `config_json` is the existing extension
boundary.

The public scheduled-task projection and desktop IPC gain optional fields, so
Host, shared types, renderer and contract tests must change together.

## Alternatives

Keeping global defaults as the only source was rejected because changing one
setting can retarget every automation.
