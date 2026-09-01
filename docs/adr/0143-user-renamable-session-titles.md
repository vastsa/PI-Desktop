# ADR 0143: Make Session Titles User-Renamable

- Status: Accepted
- Date: 2026-09-01

## Context

Tasks are durable sessions, but their labels are currently controlled by the
default title and first-prompt auto-title flow. Once a task has accumulated
history, users need a stable label that is easier to recognize in the sidebar,
Project archive, topbar, and search results. Issue #27 requests renaming a
project task without changing the task itself.

## Decision

Treat a task name as session metadata and expose one shared rename dialog. The
dialog is available from the Sidebar session overflow/right-click menu and from
the Project archive task row. It trims input, accepts 1–80 Unicode code points,
and keeps the Save action unavailable for an empty value. The host validates the
same rules so direct IPC callers cannot persist invalid titles.

Renaming updates only `sessions.title`. It does not modify the transcript,
message count, project binding, empty-session predicate, or `updated_at` activity
timestamp. A non-default title continues to opt out of first-prompt automatic
title generation. Existing `session.rename` IPC and host RPC channels are used;
no schema or protocol version change is required.

Historical notification title snapshots remain unchanged. Newly rendered
surfaces read the current session summary, so the renamed title is shown in the
Sidebar, topbar, Project archive, and search results after the local store
update and across restart.

## Consequences

- Users can name a task from both primary task navigation and the project index.
- Host-side validation provides one durable contract for renderer and future
  clients.
- Renaming cannot accidentally move a task in recent-activity order or alter
  agent context.
- The renderer owns modal focus, error presentation, and the immediate local
  title update after the host confirms the session exists.

## Alternatives considered

- Rename only from the topbar: rejected because the task can be discovered and
  managed from the Sidebar or Project archive before opening it.
- Rename the project folder or project record: rejected because the request is
  about an individual task/session, not the workspace identity.
- Add a command-palette command: deferred; the existing row actions are the
  discoverable surface and no new global command is needed for this operation.
