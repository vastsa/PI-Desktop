# ADR: Notification attention lifetimes

- Status: Accepted
- Scope: Additive local notification attention; existing history and native delivery remain unchanged.

## Context

Question toasts expire, but an unanswered ask is still actionable. Successful task
outcomes already create durable notification records outside the visible focused
chat, yet the bell hides them. Bounded history can prune an unseen completion;
users must nevertheless be able to acknowledge reminders without visiting a chat.

## Decision

- Derive question attention directly from the existing per-session open ask queues.
  Do not duplicate question ownership, persist draft answers, or interpret ordinary
  assistant prose as an interactive request. Keep the original toast/native paths.
- Use one top-right badge for every unread bell notification kind, including
  ask, permission, completion, and failure reminders. Do not duplicate completions
  mirrored in history and attention. Visible interactive reminders and their badge
  contributions share one lifecycle: navigation changes neither; accepted responses
  or cancellation remove both. Bulk read/clear hides current reminders from both
  filters and the badge without resolving decisions. Read task history remains
  durable but is omitted from the bell. Native delivery and OS taskbar policy stay unchanged.
- Rust owns a schema-34 pending completion projection inserted atomically with the
  existing unseen successful terminal notification. It has the same notification
  ID and independent retention, surviving history pruning. Ordinary read,
  mark-all-read, and clear acknowledge it without requiring navigation. Session
  deletion cancels it. Migration backfills only retained unread completed outcomes.
- Extend `notification.list` additively with a bounded pending-completion page and
  total; `completionOffset` pages independently of history. Ordinary read and bulk
  actions acknowledge completions without introducing a second read API.
  No new execution or permission boundary is introduced.
- Viewing a loaded, selected chat in a visible focused window is an optional
  acknowledgement, not the only path. Failed or superseded navigation alone retains
  attention; asynchronous acknowledgements still target exact IDs.
- Reconcile local asks after renderer bootstrap and on bell opening with bounded
  concurrency, without disabling available rows or moving focus after a late refresh.
  Remote requests retain their existing transport and lifecycle.

## Consequences

History remains bounded and clearable; completion reminders survive retention
pruning but respect explicit read/clear actions. Interactive reminder read/clear
state belongs to the renderer lifetime and never answers or approves a request.
Pending completion storage may outlive its original history row and therefore needs
its own paged read. It does not prove that a task's output is correct: completion
means the existing successful terminal turn fact, not independent acceptance.
Whole-runtime restart still does not resume an old ask Promise. Older Host binaries
reject schema 34; preserve the normal database backup before any rollback.

## Alternatives

A permanently visible toast obscures content and is not a queue. A renderer-only
completion store loses unseen reminders on reload and duplicates persistence
ownership. Requiring a chat visit for acknowledgement prevented normal bulk inbox
processing and is superseded by explicit read/clear acknowledgement.
