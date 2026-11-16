# ADR 0143: Make Session Titles User-Renamable

- Status: Accepted
- Date: 2026-09-01
- Related: Issue #27

## Context

Tasks are durable sessions, but their labels come from the default title and the
first-prompt auto-title flow, so a task with accumulated history has no stable,
recognizable label in the sidebar, Project archive, topbar, or search results.

## Decision

Treat a task name as session metadata and expose one shared rename dialog, opened
from the Sidebar session menu and the Project archive task row. It trims input,
accepts 1–80 Unicode code points, keeps Save unavailable while empty, and the host
validates the same rules so direct IPC callers cannot persist invalid titles.

Renaming updates `sessions.title` and marks its host-owned `title_source` as
`manual`, without touching the transcript, message count, project binding,
empty-session predicate, or `updated_at`. Auto-titles compare-and-set against the
automatic title, so a manual rename wins the race and only a `manual` title opts
out of automatic replacement.

## Consequences

- A task can be renamed from both primary navigation and the project index, and the
  new title appears there after the local store update and across restart.
- Renaming cannot move a task in recent-activity order or alter agent context.
- One host-side contract serves the renderer and future clients.

## Alternatives

- Rename only from the topbar — rejected: the task is discoverable elsewhere before
  it is opened.
- Rename the project record — rejected: the request is about one task.
