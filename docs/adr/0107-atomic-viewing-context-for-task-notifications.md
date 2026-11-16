# ADR 0107: Make current-session task notification suppression atomic

- Status: Accepted
- Date: 2026-08-20
- Deciders: PI-Desktop core
- Related: D117, D135, E2E-064, E2E-065, `03-runtime/01-ipc-protocol.md`

## Context

Task completion has two renderer-visible effects: the transcript receives an
agent lifecycle event, and Electron may receive a durable notification from
`session.endTurn`. The renderer previously treated every `agent_end` or terminal
`error` event as an unread sidebar outcome, even when the focused current chat
was already showing that result.

## Decision

1. Treat unread `task.completed` and `task.failed` notification records as the
   sole source of terminal sidebar marks.
2. Carry an optional `viewingSessionId` snapshot on renderer-originated
   `agent/prompt` requests.
3. Keep the existing viewing-context IPC and Main-owned visibility/focus gate.

## Consequences

- A focused user who remains in a conversation sees the transcript completion
  without a duplicate sidebar mark, inbox row, or native notification.
- Background and unfocused sessions retain durable and native recovery notices.
- The prompt request gains one additive optional field; older callers that omit
  it fail safe rather than suppressing a result using stale renderer state.
- Sidebar outcome state becomes consistent with the notification inbox and its
  read/acknowledgement lifecycle.

## Alternatives considered

### Hide the completed icon only for the selected row

Rejected: this would leave stale unread state in the store and would not prevent
durable or native notifications.

### Rely only on the React viewing-context effect

Rejected: the effect is asynchronous and can lose a race with a fast completion
or renderer navigation.
