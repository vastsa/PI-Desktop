---
title: Scheduled tasks
description: Configure recurring local agent tasks and review their results.
---

# Scheduled tasks

Open the clock in the sidebar footer, or search for **Scheduled** with
Ctrl/Cmd+K. Create a task with a name, prompt and cadence:

New tasks start in Manual. Choose a recurring cadence to enable automation.

- **Hourly:** repeat every hour; no time selection. The first run is one hour
  after saving or enabling. Restarting the app starts a new interval.
- **Daily:** choose Morning (09:00), Afternoon (14:00), Evening (19:00), or
  Night (22:00). The form does not edit hours/minutes directly.
- **Weekly:** open the weekday dropdown and select one or more days from
  Monday through Sunday. Selected days show a marker; select again to remove
  a day. At least one day is required. Choose one of the same four time periods.
- **Manual:** run only when you select Run now.

Daily and weekly schedules use the computer's local timezone. Choose the project,
permission mode and model in the task form. These choices are saved only for that
task, so changing another task or the app default does not retarget it. Auto can
run restricted actions without asking; use it only for tasks you trust.

Keep PI-Desktop running. Quitting the app stops scheduling. Missed occurrences
are skipped; startup never launches a backlog. A task does not overlap its own
unfinished run. Pause stops future occurrences without cancelling a running
conversation. Open that conversation to respond to permission requests or stop
the turn using the normal conversation controls.

**Run history** shows the latest 100 runs. **Run now** executes immediately and
opens this history view; **Open conversation** opens the result transcript.
New tasks start with Ask permission mode and the current default model selected.
Existing tasks created before these selectors keep their previous behavior until
you change them. Review prompts and the configured provider's cost before enabling tasks.

Existing tasks remain manual until you edit them and explicitly save a schedule.
Plan and Goal tasks cannot run unattended. No OS background service, cloud
scheduler or cron-expression support is installed.

## Release note (unreleased)

Scheduled tasks now execute while the desktop is running, with hourly intervals and time/weekday
configuration, per-task project/permission/model choices, editing, pause/resume, a visible clock entry and run history.
Existing data stays readable; old cadence-only records do not start automatically.

## Manage tasks in a conversation

In Agent mode, ask to create, list, update or delete scheduled tasks in the
conversation's project. For example: “Change the project review to 15:30.”
The AI uses ScheduledTaskList/Create/Update/Delete through the normal tool
permission pipeline; Ask mode requests approval for mutations. Plan/Goal
cannot use these tools. Tasks from another project are not visible or writable.

An exact time set by AI appears as Custom in the form. Editing the name or
prompt preserves it; selecting a period explicitly replaces it with that
period's default time.

Tasks also persist optional `thinkingLevel` using the existing session values
(including `off` and `omit`). The full Composer model/reasoning picker and
controller are reused with a task-draft configuration callback. Both manual and
automatic runs apply the saved level. Missing or cleared levels retain the
legacy `off` behavior; no database migration is required.
