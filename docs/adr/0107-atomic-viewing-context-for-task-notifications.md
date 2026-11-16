# ADR 0107: Make current-session task notification suppression atomic

- Status: Accepted
- Date: 2026-08-20
- Related: D117, D135, E2E-064, E2E-065

## Context

A finished task has two renderer-visible effects: the transcript receives an agent
lifecycle event, and Electron may receive a durable notification from
`session.endTurn`. The renderer treated every `agent_end` or terminal `error` as a
new unread sidebar outcome even when the focused chat already showed the result,
and the active viewing hint arrived through an asynchronous React effect that a
fast turn could outrun.

## Decision

Unread `task.completed` and `task.failed` notification records are the sole source
of terminal sidebar marks; lifecycle events keep driving run state, transcript
updates, and the in-chat result card but never create an unread outcome alone.
Renderer-originated `agent/prompt` requests carry an optional `viewingSessionId`
snapshot that Electron validates as an exact match and installs before
asynchronous turn setup, and a missing, null, or mismatched snapshot clears the
hint and fails safe to notifying. The existing viewing-context IPC and Main-owned
visibility and focus gate stay: suppression applies only to the exact finishing
session in a visible, focused window.

## Consequences

- A focused user who stays in the conversation sees the completion without a
  duplicate sidebar mark, inbox row, or native notification.
- Background, hidden, and unfocused sessions keep durable and native notices, and
  older callers that omit the field fail safe.
- Sidebar outcome state now matches the inbox and its read lifecycle.
