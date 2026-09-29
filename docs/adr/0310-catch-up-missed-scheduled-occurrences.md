# ADR 0310: Catch up occurrences missed while the app was not running

- Status: Accepted for implementation
- Date: 2026-09-29
- Amends: `scheduled-desktop-automations.md`
- Related: D635

## Context

Automatic dispatch only fires while PI-Desktop is running, and the shipped
scheduler deliberately drops anything it finds late: a due occurrence more than
90 seconds old is rearmed into the future, and startup arms future occurrences
only. The intent was to avoid a burst of stale runs after downtime, but the
effect is that closing the app — or letting the machine sleep — across a
scheduled minute loses that run silently and permanently. Users asked for the
opposite: run once when the app comes back, the way WorkBuddy does.

The maintainer's question on that request was about boundaries: was a maximum
number of retries or days needed? A retry count answers the wrong question. The
useful question is how stale a missed run may be and still be worth running, and
for a recurring task only the newest miss is ever worth running — the newer
occurrence supersedes the older ones. Replaying `n` daily occurrences is not `n`
retries of one run; it is `n` stale runs.

## Decision

Carry a catch-up policy in the task's existing `config_json` extension boundary,
with no new table, column, migration, RPC method or wire field:

- `catchUp` — a boolean, on by default.
- `catchUpWindowMinutes` — defaulting to three hours for hourly tasks and one day
  for daily and weekly tasks, clamped to 5–10080 minutes.

`due()` keeps admitting on-time occurrences and, for an occurrence later than the
90-second grace, admits the single newest miss that is still inside the window.
An occurrence older than the window is rearmed into the future instead, exactly
as before. `recover()` leaves an in-window miss armed for the next poll rather
than rearming past it. At most two catch-ups are dispatched per poll, newest
first, so the overflow waits for a later poll instead of starting together.

The existing invariants are unchanged. Paused tasks, tasks without a schedule,
`manual` cadence and a task with an unfinished run never catch up. A catch-up is
dispatched through the same `scheduled.run` path as an automatic occurrence, so
the run ledger, overlap suppression and `SCHEDULE_NOT_DUE` admission all apply,
and the dispatch path's rearm keeps one miss from producing two runs.

Hourly schedules need a closed form rather than a walk, because their cadence is
elapsed time anchored at the armed instant: the newest miss is one division away
and is therefore always within one period of now. Calendar cadences start the
walk at the later of the armed instant and the window floor, so the cost is
bounded by the window rather than by the length of the downtime.

## Consequences

A task missed while the app was closed runs once shortly after startup, and the
run history shows it like any other automatic run. The app must still be running
for any of this to happen.

The window is a boundary, not a budget the user has to size: a miss that aged out
is dropped rather than replayed, and one miss can never produce more than one
run, so a long downtime cannot build a backlog whatever the stored values are.

Daily and weekly tasks keep their calendar semantics; an hourly task's newest
miss is at most one period old, so a window narrower than that period is what
makes an hourly task skip rather than catch up.

The Scheduled page does not expose the two keys yet. Defaults apply without any
configuration, `config_json` and the existing Agent tools can set them per task,
and a follow-up can add form controls without changing this decision.
