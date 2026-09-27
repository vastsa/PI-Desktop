use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms, ts_to_ms, Database};
use crate::sessions;

/// Wire format matches the legacy Electron `scheduled-tasks.json` records so
/// the renderer keeps working unchanged (camelCase, RFC3339 timestamps).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub cadence: String,
    pub mode: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub session_id: Option<String>,
    pub status: String,
    pub error_code: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

const CADENCES: [&str; 4] = ["manual", "hourly", "daily", "weekly"];

fn normalize_cadence(value: Option<&str>) -> String {
    match value {
        Some(v) if CADENCES.contains(&v) => v.to_string(),
        _ => "manual".to_string(),
    }
}

fn normalize_mode(value: Option<&Value>) -> String {
    sessions::normalize_mode(value.and_then(Value::as_str))
}

fn config_input(value: &Value) -> Option<&Value> {
    value
        .get("configJson")
        .or_else(|| value.get("config_json"))
        .or_else(|| value.get("config"))
}

fn explicit_mode(value: &Value) -> Option<&Value> {
    value.get("mode").or_else(|| value.get("operatingMode"))
}

fn config_value(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(object)) => Value::Object(object.clone()),
        Some(Value::String(raw)) => serde_json::from_str(raw)
            .ok()
            .filter(|parsed: &Value| parsed.is_object())
            .unwrap_or_else(|| json!({})),
        _ => json!({}),
    }
}

fn config_json_value(raw: &str) -> Value {
    config_value(Some(&Value::String(raw.to_string())))
}

fn mode_from_config(config: &Value) -> String {
    normalize_mode(config.get("mode").or_else(|| config.get("operatingMode")))
}

fn task_mode(value: &Value) -> String {
    if let Some(mode) = explicit_mode(value) {
        return normalize_mode(Some(mode));
    }
    mode_from_config(&config_value(config_input(value)))
}

fn config_with_mode(mut config: Value, mode: &str) -> String {
    if !config.is_object() {
        config = json!({});
    }
    config
        .as_object_mut()
        .expect("config_json is an object")
        .insert("mode".into(), Value::String(mode.into()));
    config.to_string()
}

fn task_config_json(value: &Value) -> String {
    config_with_mode(config_value(config_input(value)), &task_mode(value))
}

fn merge_config(base: &mut Value, incoming: &Value) {
    let Some(base_object) = base.as_object_mut() else {
        *base = json!({});
        return merge_config(base, incoming);
    };
    let Some(incoming_object) = incoming.as_object() else {
        return;
    };
    for (key, value) in incoming_object {
        base_object.insert(key.clone(), value.clone());
    }
}

fn updated_config_json(db: &Database, id: &str, params_json: &Value) -> Result<Option<String>> {
    let raw: Option<String> = db
        .conn()
        .query_row(
            "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };

    if explicit_mode(params_json).is_none() && config_input(params_json).is_none() {
        return Ok(Some(raw));
    }

    let mut config = config_json_value(&raw);
    if let Some(input) = config_input(params_json) {
        merge_config(&mut config, &config_value(Some(input)));
    }
    let mode = explicit_mode(params_json)
        .map(|value| normalize_mode(Some(value)))
        .unwrap_or_else(|| mode_from_config(&config));
    Ok(Some(config_with_mode(config, &mode)))
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduledTask> {
    Ok(ScheduledTask {
        id: row.get(0)?,
        title: row.get(1)?,
        prompt: row.get(2)?,
        cadence: row.get(3)?,
        mode: mode_from_config(&config_json_value(&row.get::<_, String>(4)?)),
        enabled: row.get::<_, i64>(5)? != 0,
        created_at: ms_to_ts(row.get(6)?),
        updated_at: ms_to_ts(row.get(7)?),
        last_run_at: row.get::<_, Option<i64>>(8)?.map(ms_to_ts),
    })
}

const TASK_SELECT: &str =
    "SELECT id, title, prompt, cadence, config_json, enabled, created_at, updated_at, last_run_at
     FROM scheduled_tasks";

pub fn list_tasks(db: &Database) -> Result<Vec<ScheduledTask>> {
    let sql = format!("{TASK_SELECT} ORDER BY created_at DESC");
    let mut stmt = db.conn().prepare_cached(&sql)?;
    let rows = stmt.query_map([], task_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_task(db: &Database, id: &str) -> Result<Option<ScheduledTask>> {
    let sql = format!("{TASK_SELECT} WHERE id = ?1");
    db.conn()
        .prepare_cached(&sql)?
        .query_row(params![id], task_from_row)
        .optional()
        .map_err(Into::into)
}

pub fn create_task(db: &Database, params_json: &Value) -> Result<ScheduledTask> {
    let prompt = params_json
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title: String = params_json
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if prompt.is_empty() {
            "Scheduled task"
        } else {
            &prompt
        })
        .chars()
        .take(80)
        .collect();
    let cadence = normalize_cadence(params_json.get("cadence").and_then(|v| v.as_str()));
    let mode = task_mode(params_json);
    let config_json = config_with_mode(config_value(config_input(params_json)), &mode);
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    db.conn()
        .prepare_cached(
            "INSERT INTO scheduled_tasks
                (id, title, prompt, cadence, config_json, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        )?
        .execute(params![id, title, prompt, cadence, config_json, now])?;
    Ok(get_task(db, &id)?.expect("task just inserted"))
}

pub fn update_task(db: &Database, params_json: &Value) -> Result<Option<ScheduledTask>> {
    let Some(id) = params_json.get("id").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let cadence = params_json
        .get("cadence")
        .and_then(|v| v.as_str())
        .map(|c| normalize_cadence(Some(c)));
    let Some(config_json) = updated_config_json(db, id, params_json)? else {
        return Ok(None);
    };
    let n = db
        .conn()
        .prepare_cached(
            "UPDATE scheduled_tasks SET
                title = COALESCE(?1, title),
                prompt = COALESCE(?2, prompt),
                cadence = COALESCE(?3, cadence),
                config_json = ?4,
                enabled = COALESCE(?5, enabled),
                updated_at = ?6
             WHERE id = ?7",
        )?
        .execute(params![
            params_json.get("title").and_then(|v| v.as_str()),
            params_json.get("prompt").and_then(|v| v.as_str()),
            cadence,
            config_json,
            params_json
                .get("enabled")
                .and_then(|v| v.as_bool())
                .map(|b| if b { 1 } else { 0 }),
            now_ms(),
            id
        ])?;
    if n == 0 {
        return Ok(None);
    }
    get_task(db, id)
}

pub fn delete_task(db: &Database, id: &str) -> Result<bool> {
    let n = db
        .conn()
        .prepare_cached("DELETE FROM scheduled_tasks WHERE id = ?1")?
        .execute(params![id])?;
    Ok(n > 0)
}

/// One-shot import from the legacy Electron JSON store. Existing ids are
/// left untouched, making re-imports a no-op. Returns the imported count.
pub fn import_tasks(db: &Database, tasks: &[Value]) -> Result<usize> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let mut imported = 0;
    for task in tasks {
        let Some(id) = task.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(prompt) = task.get("prompt").and_then(|v| v.as_str()) else {
            continue;
        };
        let title = task
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Scheduled task");
        let cadence = normalize_cadence(task.get("cadence").and_then(|v| v.as_str()));
        let config_json = task_config_json(task);
        let enabled = task
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let created = task
            .get("createdAt")
            .and_then(|v| v.as_str())
            .map(ts_to_ms)
            .unwrap_or_else(now_ms);
        let updated = task
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .map(ts_to_ms)
            .unwrap_or(created);
        let last_run = task.get("lastRunAt").and_then(|v| v.as_str()).map(ts_to_ms);
        let n = tx
            .prepare_cached(
                "INSERT OR IGNORE INTO scheduled_tasks
                    (id, title, prompt, cadence, enabled, config_json, last_run_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?
            .execute(params![
                id,
                title,
                prompt,
                cadence,
                if enabled { 1 } else { 0 },
                config_json,
                last_run,
                created,
                updated
            ])?;
        imported += n;
    }
    tx.commit()?;
    Ok(imported)
}

/// Record a run start: stamps the task's last_run_at and opens a task_runs row.
pub fn begin_run(db: &Database, task_id: &str, session_id: Option<&str>) -> Result<String> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let now = now_ms();
    tx.prepare_cached(
        "UPDATE scheduled_tasks SET last_run_at = ?1, updated_at = ?1 WHERE id = ?2",
    )?
    .execute(params![now, task_id])?;
    let run_id = Uuid::new_v4().to_string();
    tx.prepare_cached(
        "INSERT INTO task_runs (id, task_id, session_id, started_at) VALUES (?1, ?2, ?3, ?4)",
    )?
    .execute(params![run_id, task_id, session_id, now])?;
    tx.commit()?;
    Ok(run_id)
}

pub fn finish_run(
    db: &Database,
    run_id: &str,
    status: &str,
    error_code: Option<&str>,
) -> Result<bool> {
    let status = match status {
        "completed" | "aborted" | "error" => status,
        _ => "completed",
    };
    let n = db
        .conn()
        .prepare_cached(
            "UPDATE task_runs SET status = ?1, error_code = ?2, ended_at = ?3
             WHERE id = ?4 AND status = 'running'",
        )?
        .execute(params![status, error_code, now_ms(), run_id])?;
    Ok(n > 0)
}

pub fn list_runs(db: &Database, task_id: Option<&str>, limit: i64) -> Result<Vec<TaskRun>> {
    let limit = limit.clamp(1, 200);
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<TaskRun> {
        Ok(TaskRun {
            id: row.get(0)?,
            task_id: row.get(1)?,
            session_id: row.get(2)?,
            status: row.get(3)?,
            error_code: row.get(4)?,
            started_at: ms_to_ts(row.get(5)?),
            ended_at: row.get::<_, Option<i64>>(6)?.map(ms_to_ts),
        })
    };
    let mut out = Vec::new();
    if let Some(task_id) = task_id {
        let mut stmt = db.conn().prepare_cached(
            "SELECT id, task_id, session_id, status, error_code, started_at, ended_at
             FROM task_runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![task_id, limit], map_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    } else {
        let mut stmt = db.conn().prepare_cached(
            "SELECT id, task_id, session_id, status, error_code, started_at, ended_at
             FROM task_runs ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], map_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn crud_and_run_lifecycle() {
        let db = test_db();
        let task = create_task(&db, &json!({ "prompt": "run tests", "cadence": "daily" })).unwrap();
        assert_eq!(task.cadence, "daily");
        assert_eq!(task.mode, "agent");
        let config: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
                params![&task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&config).unwrap()["mode"],
            "agent"
        );
        assert!(task.enabled);
        assert_eq!(task.title, "run tests");

        let updated = update_task(&db, &json!({ "id": task.id.clone(), "enabled": false }))
            .unwrap()
            .unwrap();
        assert!(!updated.enabled);

        let run = begin_run(&db, &task.id, None).unwrap();
        assert!(finish_run(&db, &run, "completed", None).unwrap());
        assert!(!finish_run(&db, &run, "completed", None).unwrap());
        let runs = list_runs(&db, Some(&task.id), 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "completed");
        let after = get_task(&db, &task.id).unwrap().unwrap();
        assert!(after.last_run_at.is_some());

        assert!(delete_task(&db, &task.id).unwrap());
        assert!(list_runs(&db, Some(&task.id), 10).unwrap().is_empty());
    }

    #[test]
    fn import_is_idempotent_and_preserves_fields() {
        let db = test_db();
        let legacy = json!([{
            "id": "t1",
            "title": "Nightly",
            "prompt": "nightly check",
            "cadence": "daily",
            "enabled": false,
            "createdAt": "2025-06-01T00:00:00Z",
            "updatedAt": "2025-06-02T00:00:00Z",
            "lastRunAt": "2025-06-03T00:00:00Z"
        }]);
        let arr = legacy.as_array().unwrap().clone();
        assert_eq!(import_tasks(&db, &arr).unwrap(), 1);
        assert_eq!(import_tasks(&db, &arr).unwrap(), 0);
        let task = get_task(&db, "t1").unwrap().unwrap();
        assert_eq!(task.title, "Nightly");
        assert!(!task.enabled);
        assert_eq!(task.mode, "agent");
        assert_eq!(
            ts_to_ms(&task.last_run_at.unwrap()),
            ts_to_ms("2025-06-03T00:00:00Z")
        );
    }

    #[test]
    fn mode_roundtrips_crud_and_import_in_config_json() {
        let db = test_db();
        let created = create_task(
            &db,
            &json!({
                "prompt": "plan this",
                "mode": "chat",
                "configJson": { "cron": "0 * * * *" }
            }),
        )
        .unwrap();
        assert_eq!(created.mode, "plan");
        let created_id = created.id.clone();
        let config: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
                params![&created_id],
                |row| row.get(0),
            )
            .unwrap();
        let config: Value = serde_json::from_str(&config).unwrap();
        assert_eq!(config["mode"], "plan");
        assert_eq!(config["cron"], "0 * * * *");

        let updated = update_task(&db, &json!({ "id": created_id.clone(), "mode": "agent" }))
            .unwrap()
            .unwrap();
        assert_eq!(updated.mode, "agent");
        let config: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
                params![&created_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&config).unwrap()["mode"],
            "agent"
        );

        let imported = json!([{
            "id": "legacy-plan",
            "prompt": "legacy",
            "configJson": { "mode": "chat", "notify": true }
        }]);
        assert_eq!(import_tasks(&db, imported.as_array().unwrap()).unwrap(), 1);
        assert_eq!(get_task(&db, "legacy-plan").unwrap().unwrap().mode, "plan");
        let config: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM scheduled_tasks WHERE id = 'legacy-plan'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let config: Value = serde_json::from_str(&config).unwrap();
        assert_eq!(config["mode"], "plan");
        assert_eq!(config["notify"], true);
    }
}
