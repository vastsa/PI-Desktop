use anyhow::{bail, Result};
use rusqlite::params;
use serde_json::{json, Value};

use super::{get_task, timing::Schedule, ScheduledTask};
use crate::db::{now_ms, Database};

const TASK_PERMISSION_MODES: [&str; 3] = ["ask", "accept-edits", "auto"];

/// Catch-up applies unless a task explicitly turns it off.
const DEFAULT_CATCH_UP: bool = true;
/// Bounds for `catchUpWindowMinutes`, so a stored value can never become an
/// unbounded replay budget.
const MIN_CATCH_UP_WINDOW_MINUTES: i64 = 5;
const MAX_CATCH_UP_WINDOW_MINUTES: i64 = 10_080;
/// A miss younger than this is an ordinary late admission, not a catch-up.
const ON_TIME_GRACE_MS: i64 = 90_000;
/// Upper bound on catch-ups dispatched per poll, so many tasks missed during one
/// downtime cannot start together.
const MAX_CATCH_UPS_PER_POLL: usize = 2;

pub fn validate_execution_input(input: &Value) -> Result<()> {
    if let Some(value) = input.get("thinkingLevel") {
        if !value.is_null()
            && !value
                .as_str()
                .is_some_and(crate::sessions::is_valid_thinking_level)
        {
            bail!("thinkingLevel must be a supported session thinking level or null");
        }
    }
    if let Some(value) = input.get("permissionMode") {
        if !value.is_null()
            && !value
                .as_str()
                .is_some_and(|mode| TASK_PERMISSION_MODES.contains(&mode))
        {
            bail!("permissionMode must be ask, accept-edits, auto, or null");
        }
    }
    let provider = input.get("providerId");
    let model = input.get("modelId");
    if provider.is_some() || model.is_some() {
        let paired_null = provider.is_some_and(Value::is_null) && model.is_some_and(Value::is_null);
        let paired_text = provider
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 256)
            && model
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 256);
        if !paired_null && !paired_text {
            bail!("providerId and modelId must be nonempty strings together, or both null");
        }
    }
    Ok(())
}

pub(crate) fn configure_execution(config: &mut Value, input: &Value) {
    let object = config
        .as_object_mut()
        .expect("scheduled task config is an object");
    if let Some(level) = input.get("thinkingLevel") {
        if level.is_null() {
            object.remove("thinkingLevel");
        } else {
            object.insert("thinkingLevel".into(), level.clone());
        }
    }
    if let Some(value) = input.get("permissionMode") {
        if value.is_null() {
            object.remove("permissionMode");
        } else if let Some(mode) = value.as_str() {
            object.insert("permissionMode".into(), json!(mode));
        }
    }
    if input.get("providerId").is_some() || input.get("modelId").is_some() {
        if input.get("providerId").is_some_and(Value::is_null) {
            object.remove("providerId");
            object.remove("modelId");
        } else {
            object.insert("providerId".into(), input["providerId"].clone());
            object.insert("modelId".into(), input["modelId"].clone());
        }
    }
}

pub fn configure(config: &mut Value, input: &Value, cadence: &str, now: i64) -> Result<()> {
    validate_execution_input(input)?;
    configure_execution(config, input);
    if let Some(schedule) = input.get("schedule") {
        let previous = config.get("schedule").cloned();
        if schedule.is_null() {
            config["schedule"] = Value::Null;
            config["calendarConfigured"] = json!(false);
        } else {
            let schedule: Schedule = serde_json::from_value(schedule.clone())?;
            schedule.validate()?;
            config["schedule"] = serde_json::to_value(schedule)?;
            if matches!(cadence, "daily" | "weekly") {
                config["calendarConfigured"] = json!(true);
            } else if previous.as_ref() != config.get("schedule") {
                config["calendarConfigured"] = json!(false);
            }
        }
    }
    if let Some(workspace) = input.get("workspacePath") {
        if !workspace.is_null() && !workspace.is_string() {
            bail!("workspacePath must be a string or null");
        }
        config["workspacePath"] = json!(workspace
            .as_str()
            .and_then(crate::db::canonical_project_path));
    }
    if input.get("schedule").is_some()
        || input.get("cadence").is_some()
        || input.get("enabled").is_some()
    {
        let next = config
            .get("schedule")
            .and_then(|value| serde_json::from_value::<Schedule>(value.clone()).ok())
            .and_then(|schedule| schedule.next(cadence, now));
        config["nextRunAt"] = json!(next);
    }
    Ok(())
}

pub fn reschedule(db: &Database, id: &str, now: i64) -> Result<()> {
    let Some(task) = get_task(db, id)? else {
        return Ok(());
    };
    let raw: String = db.conn().query_row(
        "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&raw)?;
    config["nextRunAt"] = json!(task
        .schedule
        .and_then(|schedule| schedule.next(&task.cadence, now)));
    db.conn().execute(
        "UPDATE scheduled_tasks SET config_json = ?1 WHERE id = ?2",
        params![config.to_string(), id],
    )?;
    Ok(())
}

pub fn running(db: &Database, id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id = ?1 AND status = 'running')",
        [id],
        |row| row.get(0),
    )?)
}

fn default_catch_up_window_minutes(cadence: &str) -> i64 {
    match cadence {
        "hourly" => 180,
        "daily" | "weekly" => 1_440,
        _ => 0,
    }
}

/// Resolve `catchUp` / `catchUpWindowMinutes` from the task's `config_json`.
///
/// The window is a boundary, not a retry budget: a miss older than the window is
/// dropped and at most one occurrence is caught up, so a caller never has to
/// answer "how many days" to keep a restart from replaying a backlog.
fn catch_up_policy(config: &Value, cadence: &str) -> (bool, i64) {
    // A cadence without a default window (manual, or a legacy row) has nothing
    // to catch up, whatever the stored keys say.
    let fallback = default_catch_up_window_minutes(cadence);
    let enabled = fallback > 0
        && config
            .get("catchUp")
            .and_then(Value::as_bool)
            .unwrap_or(DEFAULT_CATCH_UP);
    let minutes = config
        .get("catchUpWindowMinutes")
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
        .clamp(MIN_CATCH_UP_WINDOW_MINUTES, MAX_CATCH_UP_WINDOW_MINUTES);
    (enabled, minutes * 60_000)
}

fn task_config(db: &Database, id: &str) -> Result<Value> {
    let raw: String = db.conn().query_row(
        "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&raw).unwrap_or_else(|_| json!({})))
}

/// The single occurrence a late poll or a restart may still dispatch.
///
/// `None` means the task is paused, unarmed, has no calendar schedule, has
/// catch-up turned off, or its newest miss already fell outside the window.
fn pending_catch_up(db: &Database, task: &ScheduledTask, now: i64) -> Result<Option<i64>> {
    if !task.enabled || task.cadence == "manual" {
        return Ok(None);
    }
    let Some(schedule) = task.schedule.as_ref() else {
        return Ok(None);
    };
    let Some(armed) = task.next_run_at.as_deref().map(crate::db::ts_to_ms) else {
        return Ok(None);
    };
    if armed > now {
        return Ok(None);
    }
    let (enabled, window_ms) = catch_up_policy(&task_config(db, &task.id)?, &task.cadence);
    if !enabled {
        return Ok(None);
    }
    Ok(schedule.latest_missed(&task.cadence, armed, now, window_ms))
}

/// Polling admits on-time occurrences, then at most `MAX_CATCH_UPS_PER_POLL`
/// occurrences missed while the app was not running. Anything older than its
/// task's catch-up window is rearmed instead, so downtime never replays a
/// backlog and an unfinished run is never overlapped.
pub fn due(db: &Database, now: i64) -> Result<Vec<String>> {
    let mut on_time = Vec::new();
    let mut catch_up: Vec<(i64, String)> = Vec::new();
    for task in super::list_tasks(db)? {
        let Some(next) = task.next_run_at.as_deref().map(crate::db::ts_to_ms) else {
            continue;
        };
        if !task.enabled || task.schedule.is_none() || task.cadence == "manual" || next > now {
            continue;
        }
        if running(db, &task.id)? {
            reschedule(db, &task.id, now)?;
            continue;
        }
        if now - next <= ON_TIME_GRACE_MS {
            on_time.push(task.id);
            continue;
        }
        match pending_catch_up(db, &task, now)? {
            Some(missed) => catch_up.push((missed, task.id)),
            None => reschedule(db, &task.id, now)?,
        }
    }
    // Newest misses first; the overflow stays armed and waits for a later poll.
    catch_up.sort_by_key(|(missed, _)| std::cmp::Reverse(*missed));
    catch_up.truncate(MAX_CATCH_UPS_PER_POLL);
    on_time.extend(catch_up.into_iter().map(|(_, id)| id));
    Ok(on_time)
}

pub fn recover(db: &Database) -> Result<()> {
    // Database boot maintenance owns interruption of orphaned task_runs.
    // A miss inside its catch-up window stays armed so the next poll dispatches
    // exactly one catch-up; anything older is rearmed to a future occurrence, so
    // downtime never creates a burst.
    let now = now_ms();
    for task in super::list_tasks(db)? {
        if task.schedule.is_none() {
            continue;
        }
        if pending_catch_up(db, &task, now)?.is_some() {
            continue;
        }
        reschedule(db, &task.id, now)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled::{begin_run, create_task, finish_run, update_task};

    #[test]
    fn legacy_tasks_are_not_armed_and_explicit_schedule_survives_edits() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(&db, &json!({"prompt":"check", "cadence":"daily"})).unwrap();
        assert!(task.schedule.is_none());
        assert!(due(&db, now_ms()).unwrap().is_empty());
        let task = update_task(
            &db,
            &json!({"id":task.id,"schedule":{"hour":9,"minute":0,"weekday":0}}),
        )
        .unwrap()
        .unwrap();
        assert!(task.next_run_at.is_some());
        let edited = update_task(&db, &json!({"id":task.id,"title":"Edited"}))
            .unwrap()
            .unwrap();
        assert_eq!(edited.next_run_at, task.next_run_at);
    }

    #[test]
    fn due_paused_overlap_missed_and_restart_paths() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(&db, &json!({"prompt":"check", "cadence":"hourly", "schedule":{"hour":9,"minute":0,"weekday":0}})).unwrap();
        let at = crate::db::ts_to_ms(task.next_run_at.as_ref().unwrap());
        assert_eq!(due(&db, at).unwrap(), vec![task.id.clone()]);
        let run = begin_run(&db, &task.id, None).unwrap();
        assert!(due(&db, at).unwrap().is_empty());
        finish_run(&db, &run, "completed", None).unwrap();
        // Late but inside the default hourly window: caught up exactly once, and
        // the dispatch path's rearm keeps the next poll from repeating it.
        let late = at + 3_600_000 + 90_001;
        assert_eq!(due(&db, late).unwrap(), vec![task.id.clone()]);
        reschedule(&db, &task.id, late).unwrap();
        assert!(due(&db, late).unwrap().is_empty());
        update_task(&db, &json!({"id":task.id,"enabled":false})).unwrap();
        assert!(due(&db, at + 10 * 3_600_000).unwrap().is_empty());
        let interrupted = begin_run(&db, &task.id, None).unwrap();
        drop(db);
        let db = Database::open_in_dir(dir.path()).unwrap();
        recover(&db).unwrap();
        assert!(!running(&db, &task.id).unwrap());
        assert_eq!(
            super::super::list_runs(&db, Some(&task.id), 100)
                .unwrap()
                .into_iter()
                .find(|run| run.id == interrupted)
                .unwrap()
                .status,
            "aborted"
        );
    }

    /// Arm a task at an explicit `nextRunAt` so a test can place a miss.
    fn arm_at(db: &Database, id: &str, ms: i64) {
        let raw: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        let mut config: Value = serde_json::from_str(&raw).unwrap();
        config["nextRunAt"] = json!(ms);
        db.conn()
            .execute(
                "UPDATE scheduled_tasks SET config_json = ?1 WHERE id = ?2",
                params![config.to_string(), id],
            )
            .unwrap();
    }

    fn armed_at(db: &Database, id: &str) -> Option<i64> {
        task_config(db, id)
            .unwrap()
            .get("nextRunAt")
            .and_then(Value::as_i64)
    }

    /// Hourly cadence keeps every assertion free of the host timezone; the
    /// calendar arithmetic itself is covered in `timing.rs`.
    fn hourly_task(db: &Database, config_json: Value) -> ScheduledTask {
        create_task(
            db,
            &json!({
                "prompt": "check",
                "cadence": "hourly",
                "schedule": {"hour": 9, "minute": 0, "weekday": 0},
                "configJson": config_json
            }),
        )
        .unwrap()
    }

    const HOUR: i64 = 3_600_000;

    #[test]
    fn catch_up_window_defaults_follow_cadence_and_clamp() {
        assert_eq!(catch_up_policy(&json!({}), "hourly"), (true, 180 * 60_000));
        assert_eq!(catch_up_policy(&json!({}), "daily"), (true, 1_440 * 60_000));
        assert_eq!(
            catch_up_policy(&json!({}), "weekly"),
            (true, 1_440 * 60_000)
        );
        // An explicit window is clamped into the documented range.
        assert_eq!(
            catch_up_policy(&json!({"catchUpWindowMinutes": 1}), "hourly").1,
            MIN_CATCH_UP_WINDOW_MINUTES * 60_000
        );
        assert_eq!(
            catch_up_policy(&json!({"catchUpWindowMinutes": 999_999}), "daily").1,
            MAX_CATCH_UP_WINDOW_MINUTES * 60_000
        );
    }

    #[test]
    fn catch_up_is_off_where_there_is_no_window() {
        assert!(!catch_up_policy(&json!({}), "manual").0);
        assert!(!catch_up_policy(&json!({"catchUp": true}), "manual").0);
        assert!(!catch_up_policy(&json!({"catchUp": false}), "daily").0);
        assert!(catch_up_policy(&json!({}), "daily").0);
    }

    #[test]
    fn boot_keeps_a_miss_inside_the_window_and_dispatches_it_once() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = hourly_task(&db, json!({}));
        let base = now_ms();
        let miss = base - 2 * HOUR;
        arm_at(&db, &task.id, miss);
        recover(&db).unwrap();
        assert_eq!(
            armed_at(&db, &task.id),
            Some(miss),
            "boot leaves an in-window miss armed for the next poll"
        );
        assert_eq!(due(&db, base).unwrap(), vec![task.id.clone()]);
        reschedule(&db, &task.id, base).unwrap();
        assert!(due(&db, base).unwrap().is_empty(), "one miss, one catch-up");
    }

    #[test]
    fn a_miss_older_than_the_window_is_rearmed_instead_of_caught_up() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = hourly_task(&db, json!({"catchUpWindowMinutes": 5}));
        let base = now_ms();
        // Hourly occurrences recur every hour, so the newest miss sits at
        // `armed + 2h` — ten minutes old here, past a five-minute window.
        arm_at(&db, &task.id, base - 2 * HOUR - 10 * 60_000);
        assert!(due(&db, base).unwrap().is_empty());
        assert!(
            armed_at(&db, &task.id).unwrap() > base,
            "a stale miss is dropped, not replayed"
        );
    }

    #[test]
    fn catch_up_can_be_disabled_per_task() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = hourly_task(&db, json!({"catchUp": false}));
        let base = now_ms();
        arm_at(&db, &task.id, base - 2 * HOUR);
        assert!(due(&db, base).unwrap().is_empty());
        assert!(armed_at(&db, &task.id).unwrap() > base);
    }

    #[test]
    fn paused_tasks_keep_their_miss_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = hourly_task(&db, json!({}));
        let base = now_ms();
        let miss = base - 2 * HOUR;
        update_task(&db, &json!({"id": task.id, "enabled": false})).unwrap();
        // Pausing re-arms the task, so the miss is placed after the pause.
        arm_at(&db, &task.id, miss);
        assert!(due(&db, base).unwrap().is_empty());
        assert_eq!(armed_at(&db, &task.id), Some(miss));
    }

    #[test]
    fn a_running_task_suppresses_its_own_catch_up() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = hourly_task(&db, json!({}));
        let base = now_ms();
        arm_at(&db, &task.id, base - 2 * HOUR);
        let run = begin_run(&db, &task.id, None).unwrap();
        assert!(due(&db, base).unwrap().is_empty());
        assert!(
            armed_at(&db, &task.id).unwrap() > base,
            "an unfinished run re-arms the task instead of overlapping it"
        );
        finish_run(&db, &run, "completed", None).unwrap();
    }

    #[test]
    fn catch_ups_are_capped_per_poll() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let base = now_ms();
        let mut ids = Vec::new();
        for _ in 0..3 {
            let task = hourly_task(&db, json!({}));
            arm_at(&db, &task.id, base - 2 * HOUR);
            ids.push(task.id);
        }
        let first = due(&db, base).unwrap();
        assert_eq!(
            first.len(),
            MAX_CATCH_UPS_PER_POLL,
            "one poll cannot start every missed task together"
        );
        for id in &first {
            reschedule(&db, id, base).unwrap();
        }
        let second = due(&db, base).unwrap();
        assert_eq!(second.len(), 1, "the overflow waits for a later poll");
        assert!(!first.contains(&second[0]));
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn legacy_tasks_without_a_schedule_are_never_caught_up() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(&db, &json!({"prompt": "legacy", "cadence": "daily"})).unwrap();
        recover(&db).unwrap();
        assert!(task.next_run_at.is_none());
        assert!(due(&db, now_ms()).unwrap().is_empty());
    }
}
