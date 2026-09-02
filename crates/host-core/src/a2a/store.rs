//! SQLite persistence for A2A tasks, messages, artifacts, and push configs.
//!
//! The agent registry and capability tokens live only in memory (see
//! [`crate::a2a::A2aBroker`]); this module persists the durable task state so a
//! peer can fetch a task after a reconnect. All functions take the shared
//! `rusqlite` connection owned by [`crate::db::Database`].

use rusqlite::{params, Connection, OptionalExtension};

use super::types::{
    A2aError, Artifact, Message, PushNotificationConfig, Task, TaskKind, TaskState, TaskStatus,
};
use crate::db::{ms_to_ts, now_ms};

/// `CREATE TABLE` statements for the A2A tables. Applied on a fresh database
/// and in the v11→v12 migration; purely additive (empty tables, no backfill).
pub const A2A_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id                  TEXT PRIMARY KEY,
  context_id          TEXT NOT NULL,
  agent_name          TEXT NOT NULL,
  requester_name      TEXT NOT NULL,
  state               TEXT NOT NULL,
  status_timestamp    TEXT NOT NULL,
  status_message_json TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context
  ON a2a_tasks(context_id, created_at DESC);

CREATE TABLE IF NOT EXISTS a2a_messages (
  message_id   TEXT NOT NULL,
  task_id      TEXT NOT NULL REFERENCES a2a_tasks(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (task_id, message_id),
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_a2a_messages_task
  ON a2a_messages(task_id, seq);

CREATE TABLE IF NOT EXISTS a2a_artifacts (
  artifact_id   TEXT NOT NULL,
  task_id       TEXT NOT NULL REFERENCES a2a_tasks(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  artifact_json TEXT NOT NULL,
  PRIMARY KEY (task_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_task
  ON a2a_artifacts(task_id, seq);

CREATE TABLE IF NOT EXISTS a2a_push_configs (
  task_id     TEXT PRIMARY KEY REFERENCES a2a_tasks(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
"#;

fn internal<E: std::fmt::Display>(error: E) -> A2aError {
    A2aError::Internal(error.to_string())
}

/// Persist a brand-new task with its initial history and artifacts.
pub fn insert_task(conn: &Connection, task: &Task) -> Result<(), A2aError> {
    let now = now_ms();
    let status_message_json = match &task.status.message {
        Some(message) => Some(serde_json::to_string(message).map_err(internal)?),
        None => None,
    };
    conn.execute(
        "INSERT INTO a2a_tasks
            (id, context_id, agent_name, requester_name, state, status_timestamp,
             status_message_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            task.id,
            task.context_id,
            task.agent_name,
            task.requester_name,
            serde_json::to_string(&task.status.state)
                .map_err(internal)?
                .trim_matches('"'),
            task.status.timestamp,
            status_message_json,
            now,
        ],
    )
    .map_err(internal)?;
    for (seq, message) in task.history.iter().enumerate() {
        insert_message_row(conn, &task.id, seq as i64, message, now)?;
    }
    for (seq, artifact) in task.artifacts.iter().enumerate() {
        conn.execute(
            "INSERT INTO a2a_artifacts (artifact_id, task_id, seq, artifact_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                artifact.artifact_id,
                task.id,
                seq as i64,
                serde_json::to_string(artifact).map_err(internal)?
            ],
        )
        .map_err(internal)?;
    }
    Ok(())
}

fn insert_message_row(
    conn: &Connection,
    task_id: &str,
    seq: i64,
    message: &Message,
    now: i64,
) -> Result<(), A2aError> {
    conn.execute(
        "INSERT INTO a2a_messages (message_id, task_id, seq, message_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            message.message_id,
            task_id,
            seq,
            serde_json::to_string(message).map_err(internal)?,
            now,
        ],
    )
    .map_err(internal)?;
    Ok(())
}

/// Append a message to a task's history, returning its assigned sequence.
pub fn append_message(
    conn: &Connection,
    task_id: &str,
    message: &Message,
) -> Result<i64, A2aError> {
    let next_seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq) + 1, 0) FROM a2a_messages WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    insert_message_row(conn, task_id, next_seq, message, now_ms())?;
    Ok(next_seq)
}

/// Keep only the newest `max` messages for a task (oldest-first eviction).
pub fn cap_history(conn: &Connection, task_id: &str, max: usize) -> Result<(), A2aError> {
    conn.execute(
        "DELETE FROM a2a_messages
         WHERE task_id = ?1 AND seq NOT IN (
             SELECT seq FROM a2a_messages WHERE task_id = ?1
             ORDER BY seq DESC LIMIT ?2
         )",
        params![task_id, max as i64],
    )
    .map_err(internal)?;
    Ok(())
}

/// Update a task's status (state, timestamp, and optional status message).
pub fn update_status(
    conn: &Connection,
    task_id: &str,
    status: &TaskStatus,
) -> Result<(), A2aError> {
    let status_message_json = match &status.message {
        Some(message) => Some(serde_json::to_string(message).map_err(internal)?),
        None => None,
    };
    conn.execute(
        "UPDATE a2a_tasks
         SET state = ?2, status_timestamp = ?3, status_message_json = ?4, updated_at = ?5
         WHERE id = ?1",
        params![
            task_id,
            serde_json::to_string(&status.state)
                .map_err(internal)?
                .trim_matches('"'),
            status.timestamp,
            status_message_json,
            now_ms(),
        ],
    )
    .map_err(internal)?;
    Ok(())
}

/// Load a task by id, reconstructing history (seq order) and artifacts.
pub fn load_task(conn: &Connection, id: &str) -> Result<Option<Task>, A2aError> {
    let row = conn
        .query_row(
            "SELECT context_id, agent_name, requester_name, state, status_timestamp, status_message_json
             FROM a2a_tasks WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(internal)?;
    let Some((context_id, agent_name, requester_name, state_raw, timestamp, status_message_json)) =
        row
    else {
        return Ok(None);
    };
    let state: TaskState =
        serde_json::from_value(serde_json::Value::String(state_raw)).map_err(internal)?;
    let message = match status_message_json {
        Some(raw) => Some(serde_json::from_str(&raw).map_err(internal)?),
        None => None,
    };
    let history = load_history(conn, id)?;
    let artifacts = load_artifacts(conn, id)?;
    Ok(Some(Task {
        kind: TaskKind::Task,
        id: id.to_string(),
        context_id,
        status: TaskStatus {
            state,
            message,
            timestamp,
        },
        history,
        artifacts,
        agent_name,
        requester_name,
    }))
}

fn load_history(conn: &Connection, task_id: &str) -> Result<Vec<Message>, A2aError> {
    let mut stmt = conn
        .prepare("SELECT message_json FROM a2a_messages WHERE task_id = ?1 ORDER BY seq ASC")
        .map_err(internal)?;
    let rows = stmt
        .query_map(params![task_id], |row| row.get::<_, String>(0))
        .map_err(internal)?;
    let mut history = Vec::new();
    for row in rows {
        let raw = row.map_err(internal)?;
        history.push(serde_json::from_str(&raw).map_err(internal)?);
    }
    Ok(history)
}

fn load_artifacts(conn: &Connection, task_id: &str) -> Result<Vec<Artifact>, A2aError> {
    let mut stmt = conn
        .prepare("SELECT artifact_json FROM a2a_artifacts WHERE task_id = ?1 ORDER BY seq ASC")
        .map_err(internal)?;
    let rows = stmt
        .query_map(params![task_id], |row| row.get::<_, String>(0))
        .map_err(internal)?;
    let mut artifacts = Vec::new();
    for row in rows {
        let raw = row.map_err(internal)?;
        artifacts.push(serde_json::from_str(&raw).map_err(internal)?);
    }
    Ok(artifacts)
}

/// Load non-terminal tasks associated with a peer.
pub fn active_tasks_for_peer(conn: &Connection, peer: &str) -> Result<Vec<Task>, A2aError> {
    let mut stmt = conn
        .prepare("SELECT id FROM a2a_tasks WHERE (agent_name = ?1 OR requester_name = ?1) AND state NOT IN ('completed', 'canceled', 'failed', 'rejected')")
        .map_err(internal)?;
    let ids = stmt
        .query_map(params![peer], |row| row.get::<_, String>(0))
        .map_err(internal)?;
    let mut tasks = Vec::new();
    for id in ids {
        let id = id.map_err(internal)?;
        if let Some(task) = load_task(conn, &id)? {
            tasks.push(task);
        }
    }
    Ok(tasks)
}

/// Count the tasks currently persisted for a context.
pub fn count_tasks_in_context(conn: &Connection, context_id: &str) -> Result<usize, A2aError> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM a2a_tasks WHERE context_id = ?1",
            params![context_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    Ok(count as usize)
}

/// Upsert the push-notification config for a task.
pub fn set_push_config(
    conn: &Connection,
    task_id: &str,
    config: &PushNotificationConfig,
) -> Result<(), A2aError> {
    conn.execute(
        "INSERT INTO a2a_push_configs (task_id, config_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(task_id) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at",
        params![
            task_id,
            serde_json::to_string(config).map_err(internal)?,
            now_ms(),
        ],
    )
    .map_err(internal)?;
    Ok(())
}

/// Read the push-notification config for a task, if any.
pub fn get_push_config(
    conn: &Connection,
    task_id: &str,
) -> Result<Option<PushNotificationConfig>, A2aError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT config_json FROM a2a_push_configs WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    match raw {
        Some(raw) => Ok(Some(serde_json::from_str(&raw).map_err(internal)?)),
        None => Ok(None),
    }
}

/// RFC3339 (UTC millis) timestamp for a transition, shared with the broker.
pub fn now_ts() -> String {
    ms_to_ts(now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a2a::types::{Part, Role};
    use crate::db::Database;

    fn open_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn sample_message(id: &str, text: &str) -> Message {
        Message {
            role: Role::User,
            parts: vec![Part::Text { text: text.into() }],
            message_id: id.into(),
            task_id: None,
            context_id: Some("ctx".into()),
            from: Some("peer-a".into()),
            to: Some("peer-b".into()),
        }
    }

    fn sample_task() -> Task {
        Task {
            kind: TaskKind::Task,
            id: "task-1".into(),
            context_id: "ctx".into(),
            status: TaskStatus {
                state: TaskState::Working,
                message: None,
                timestamp: now_ts(),
            },
            history: vec![sample_message("m1", "hello")],
            artifacts: vec![],
            agent_name: "peer-b".into(),
            requester_name: "peer-a".into(),
        }
    }

    #[test]
    fn task_round_trips_through_the_store() {
        let (_dir, db) = open_db();
        let task = sample_task();
        insert_task(db.conn(), &task).unwrap();
        let loaded = load_task(db.conn(), "task-1").unwrap().unwrap();
        assert_eq!(loaded, task);
        assert_eq!(count_tasks_in_context(db.conn(), "ctx").unwrap(), 1);
        assert!(load_task(db.conn(), "missing").unwrap().is_none());
    }

    #[test]
    fn append_and_cap_history_evicts_oldest() {
        let (_dir, db) = open_db();
        insert_task(db.conn(), &sample_task()).unwrap();
        append_message(db.conn(), "task-1", &sample_message("m2", "two")).unwrap();
        append_message(db.conn(), "task-1", &sample_message("m3", "three")).unwrap();
        cap_history(db.conn(), "task-1", 2).unwrap();
        let loaded = load_task(db.conn(), "task-1").unwrap().unwrap();
        let ids: Vec<&str> = loaded
            .history
            .iter()
            .map(|m| m.message_id.as_str())
            .collect();
        assert_eq!(ids, vec!["m2", "m3"]);
    }

    #[test]
    fn push_config_set_and_get_round_trip() {
        let (_dir, db) = open_db();
        insert_task(db.conn(), &sample_task()).unwrap();
        assert!(get_push_config(db.conn(), "task-1").unwrap().is_none());
        let config = PushNotificationConfig {
            id: "cfg-1".into(),
            url: None,
            token: Some("secret".into()),
        };
        set_push_config(db.conn(), "task-1", &config).unwrap();
        assert_eq!(get_push_config(db.conn(), "task-1").unwrap(), Some(config));
    }
}
