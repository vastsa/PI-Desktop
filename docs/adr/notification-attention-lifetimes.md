# ADR: Notification attention lifetimes

- Status: Accepted
- Scope: Local notification attention derived from existing requests and bounded notification history; native delivery remains unchanged.

## Context

Question toasts expire, but an unanswered ask is still actionable. Successful task
outcomes already create durable notification records outside the visible focused
chat, yet the bell hides them. The existing notification table is bounded to the
latest 200 outcomes, so an unseen completion can be pruned. This decision accepts
that limit rather than introducing a second durable reminder store.

## Decision

- Derive question attention directly from the existing per-session open ask queues.
  Do not duplicate question ownership, persist draft answers, or interpret ordinary
  assistant prose as an interactive request. Keep the original toast/native paths.
- Use one top-right badge: `unreadNotificationCount` (both successful and failed
  outcomes) plus visible ask and permission reminders. Completion rows are derived
  from unread `task.completed` records in the ordinary notification list, never
  counted through a second attention/history path. Read records remain in history
  but are omitted from the bell.
- Keep schema 33 and the existing `notifications` table as the sole durable source
  for completion reminders. Add no schema bump, migration, or table. Reminders
  survive restart only while their unread rows remain within the latest 200
  notifications; pruning may deliberately discard unread completion reminders.
- Keep the existing notification list, read, mark-all-read, and clear request and
  result contracts. There is no separate completion pagination or load-more path.
  Ordinary read acknowledges a retained completion; mark-all-read updates unread
  notification rows, and clear deletes notification history. No new execution or
  permission boundary is introduced.
- Navigation retains ask/permission reminders and their badge contributions.
  Accepted answers/decisions or authoritative cancellation remove them. Bulk
  read/clear hides current interactive reminders for the renderer lifetime,
  including sidebar remounts, without answering, approving, denying, or cancelling
  the underlying requests. Native delivery and OS taskbar policy stay unchanged.
- Viewing a successfully loaded, selected chat in a visible focused window is an
  optional completion acknowledgement, not the only path. Failed or superseded
  navigation retains its reminder; asynchronous acknowledgements target exact IDs
  only after confirming the intended chat is still selected and visible/focused.
- Reconcile local asks after renderer bootstrap and on bell opening with bounded
  concurrency, without disabling available rows or moving focus after a late refresh.
  Remote requests retain their existing transport and lifecycle.

## Consequences

One bounded table owns durable completion state and its unread count; no new
storage lifecycle or protocol fields are needed. Explicit read/clear actions and
retention pruning remove completion reminders. An unread outcome older than the
latest 200 notifications is not guaranteed to remain actionable after refresh or
restart. Interactive reminder dismissal belongs to the renderer lifetime and never
answers or approves a request. Completion means the existing successful terminal
turn fact, not independent verification of its output. Whole-runtime restart still
does not resume an old ask Promise.

## Alternatives

A permanently visible toast obscures content and is not a queue. A renderer-only
completion store loses retained reminders on reload and duplicates persistence
ownership. An independently retained completion projection would preserve unread
outcomes beyond 200 records, but adds a migration, a separate retention lifecycle,
paging, and count reconciliation. The bounded existing table is chosen instead,
with unread pruning explicitly accepted. Requiring a chat visit for acknowledgement
also prevents normal bulk inbox processing; explicit read/clear remains available.
