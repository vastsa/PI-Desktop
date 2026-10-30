# ADR: Optional scheduled-task shortcuts in the sidebar

- Status: Implemented candidate
- Date: 2026-10-29
- Related issue: #1962

## Context

The Scheduled workspace owns automation transcripts so recurring executions do
not fill ordinary conversation lists. Some users also want a direct sidebar
entry for a particular task instead of opening the task index first.

## Decision

Add `AppSettings.sidebarScheduledTasks` as an optional, default-off display
preference. Only projects with explicitly bound tasks gain a Scheduled
subfolder while enabled; ordinary conversation rows stay directly under their
project. Match normalized task `workspacePath` values to retained project keys.
Unbound tasks and tasks under closed projects stay in the management page;
there is no global or empty sidebar task group. Activation selects the existing
task detail and run history. It never creates,
enables or executes a task and preserves transcript ownership and exclusion
from conversation search.

Keep task definitions and results in Rust. The renderer reads the existing task
and newest-run queries while shortcuts are enabled, using the Scheduled page's
ten-second cadence plus focus refresh. Stale reads cannot replace newer state
or restore a disabled group. The existing running-indicator settings gate the
count and rail, including parent activity while a project is folded. Save each
folder under `pi.desktop.sidebarScheduledTasksCollapsed:<normalized path>`,
outside project metadata and independently of other folders. The draft's
previous global fold value is not inherited by all projects.

Reuse the sidebar search from #1955, preserving its author and source commit.
The display preference also controls task-name participation in sidebar search.
Use the same trimmed, case-insensitive substring match as other sidebar entries
and filter loaded tasks without restarting the polling lifecycle. Search
temporarily expands the task folder and owning project without writing either
fold preference; clearing restores both. Closed-project and unbound tasks never
contribute results. Loading and errors use a separate read-status notice so
uncertain membership cannot create an empty folder.

## Consequences

Existing installs retain the current navigation by default. Enabling shortcuts
adds read-only polling and per-task navigation; failures expose Retry. The
boolean travels through existing settings persistence without a database or
protocol migration. Old clients ignore it.

## Alternatives

Reintroducing each run as a conversation would undo the ownership decision and
grow the sidebar with every execution. A global task group hides project
ownership. The approved design keeps conversation rows direct and adds only a
Scheduled subfolder under its project, leaving run records under the task.
