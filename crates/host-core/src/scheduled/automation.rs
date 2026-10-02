use anyhow::{bail, Result};
use rusqlite::params;
use serde_json::{json, Value};

use super::{get_task, timing::Schedule};
use crate::db::{now_ms, Database};

const TASK_PERMISSION_MODES: [&str; 3] = ["ask", "accept-edits", "auto"];

/// Whether a run opens its own conversation or continues the task's previous
/// one. `perRun` is the historical behavior.
pub const TASK_SESSION_MODES: [&str; 2] = ["perRun", "reuse"];

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
    if let Some(value) = input.get("sessionMode") {
        if !value.is_null()
            && !value
                .as_str()
                .is_some_and(|mode| TASK_SESSION_MODES.contains(&mode))
        {
            bail!("sessionMode must be perRun, reuse, or null");
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
    if let Some(value) = input.get("sessionMode") {
        if value.is_null() {
            object.remove("sessionMode");
        } else if let Some(mode) = value.as_str() {
            object.insert("sessionMode".into(), json!(mode));
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
        let armed = config
            .get("schedule")
            .and_then(|value| serde_json::from_value::<Schedule>(value.clone()).ok());
        // An interval task is armed by its own value: a schedule without
        // intervalMinutes would leave the next occurrence empty, so the input
        // is refused instead of saved as a task that never fires.
        if cadence == "interval"
            && armed
                .as_ref()
                .and_then(|schedule| schedule.interval_minutes)
                .is_none()
        {
            bail!("an interval schedule requires intervalMinutes");
        }
        config["nextRunAt"] = json!(armed.and_then(|schedule| schedule.next(cadence, now)));
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

/// Polling never replays missed occurrences or overlaps an unfinished run.
pub fn due(db: &Database, now: i64) -> Result<Vec<String>> {
    let mut result = Vec::new();
    for task in super::list_tasks(db)? {
        let Some(next) = task.next_run_at.as_deref().map(crate::db::ts_to_ms) else {
            continue;
        };
        if !task.enabled || task.schedule.is_none() || task.cadence == "manual" || next > now {
            continue;
        }
        if now - next > 90_000 || running(db, &task.id)? {
            reschedule(db, &task.id, now)?;
        } else {
            result.push(task.id);
        }
    }
    Ok(result)
}

pub fn recover(db: &Database) -> Result<()> {
    // Database boot maintenance owns interruption of orphaned task_runs.
    // Restart starts from future occurrences; downtime never creates a burst.
    for task in super::list_tasks(db)? {
        if task.schedule.is_some() {
            reschedule(db, &task.id, now_ms())?;
        }
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
        assert!(due(&db, at + 3_600_000 + 90_001).unwrap().is_empty());
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

    #[test]
    fn interval_tasks_wait_their_own_minutes_and_need_their_value() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let rejected = create_task(
            &db,
            &json!({"prompt":"check", "cadence":"interval", "schedule":{"hour":0,"minute":0,"weekday":0}}),
        );
        assert!(
            rejected.is_err(),
            "an interval schedule without its value would never fire"
        );

        let task = create_task(
            &db,
            &json!({"prompt":"check", "cadence":"interval",
                    "schedule":{"hour":0,"minute":0,"weekday":0,"intervalMinutes":15}}),
        )
        .unwrap();
        let next = crate::db::ts_to_ms(task.next_run_at.as_ref().unwrap());
        let now = now_ms();
        assert!(next > now && next <= now + 15 * 60_000 + 5_000);
        assert!(due(&db, next - 60_000).unwrap().is_empty(), "not due yet");
        assert_eq!(due(&db, next).unwrap(), vec![task.id.clone()]);

        // A cadence switch keeps the value for the way back and arms the new
        // rule from it instead.
        let daily = update_task(
            &db,
            &json!({"id":task.id,"cadence":"daily",
                    "schedule":{"hour":9,"minute":30,"weekday":0,"intervalMinutes":15}}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(daily.cadence, "daily");
        assert_eq!(
            daily
                .schedule
                .as_ref()
                .and_then(|item| item.interval_minutes),
            Some(15)
        );
        assert!(daily.next_run_at.is_some(), "a daily task keeps its clock");
    }
}
