//! Session checklist: validation, storage, and the single write path.
//!
//! `session_todo` rows plus the `sessions.todo_revision` / `todo_updated_at`
//! stamps are the authoritative checklist; host-core SQLite is the only
//! writer. `TodoWrite` replaces the whole list in one transaction, so no
//! reader can observe a half-applied list, and an empty list still advances
//! the revision so a clear stays distinguishable from "nothing happened".

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{now_ms, Database};

/// Hard cap on one checklist, mirrored by the `session_todo` CHECK.
pub const MAX_TODOS: usize = 50;
/// Longest accepted item content in Unicode scalar values. Longer content is
/// truncated with a warning instead of rejected: a model that writes a
/// paragraph should still make progress, while the stored row stays bounded.
pub const MAX_TODO_CONTENT_CHARS: usize = 500;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_IN_PROGRESS: &str = "in_progress";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_CANCELLED: &str = "cancelled";

pub const PRIORITY_HIGH: &str = "high";
pub const PRIORITY_MEDIUM: &str = "medium";
pub const PRIORITY_LOW: &str = "low";

/// Keep in sync with the `session_todo` CHECK constraints in
/// `crate::db::schema::SESSION_TODO_DDL`.
pub const TODO_STATUSES: [&str; 4] = [
    STATUS_PENDING,
    STATUS_IN_PROGRESS,
    STATUS_COMPLETED,
    STATUS_CANCELLED,
];
pub const TODO_PRIORITIES: [&str; 3] = [PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW];

/// The only argument `TodoWrite` accepts. The owner session and turn come
/// from the transport, so anything else — `sessionId` included — is refused
/// rather than ignored.
const TODOS_ARG: &str = "todos";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: String,
    pub priority: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoSnapshot {
    pub session_id: String,
    pub todos: Vec<TodoItem>,
    /// Monotonic per-session counter; `0` means the session never wrote one.
    pub revision: i64,
    /// Epoch ms of the last successful write, `0` before the first write.
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct NormalizedTodos {
    pub items: Vec<TodoItem>,
    /// Bounded, single-line notes for the model and the tool result. They
    /// never carry a whole checklist, only what was changed about the input.
    pub warnings: Vec<String>,
}

/// Why a `TodoWrite` must not commit. The RPC layer maps each variant to one
/// wire `errorCode`; a refusal never mutates and never emits an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoRefusal {
    /// Unknown session, or a row already marked deleted.
    SessionNotFound,
    /// The durable mode is not `agent` (Plan/Goal never own a checklist).
    SessionNotAgent,
    /// The call carried no `turnId`.
    TurnMissing,
    /// The turn is unknown, belongs to another session, or is no longer
    /// running.
    TurnNotRunning,
}

#[derive(Debug)]
pub enum TodoWriteError {
    Refused(TodoRefusal),
    Internal(anyhow::Error),
}

impl std::fmt::Display for TodoWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refusal) => write!(f, "{refusal:?}"),
            Self::Internal(error) => write!(f, "{error}"),
        }
    }
}

impl From<rusqlite::Error> for TodoWriteError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Internal(error.into())
    }
}

/// Validate and normalize one `TodoWrite` payload.
///
/// Rejections are total: nothing here touches the database, so an invalid
/// payload can never leave a partial replacement behind. Content is trimmed,
/// must be non-empty, must not contain NUL, and is truncated to
/// [`MAX_TODO_CONTENT_CHARS`] with a warning. Only the first `in_progress`
/// item survives; later ones are demoted to `pending`.
pub fn normalize_input(value: &Value) -> Result<NormalizedTodos> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("TodoWrite arguments must be an object"))?;
    if let Some(unknown) = object.keys().find(|key| key.as_str() != TODOS_ARG) {
        return Err(anyhow!(
            "TodoWrite does not accept the `{unknown}` argument; the owner session and turn come from the transport"
        ));
    }
    let todos = object
        .get(TODOS_ARG)
        .ok_or_else(|| anyhow!("TodoWrite requires a todos array"))?
        .as_array()
        .ok_or_else(|| anyhow!("TodoWrite.todos must be an array"))?;
    if todos.len() > MAX_TODOS {
        return Err(anyhow!(
            "TodoWrite accepts at most {MAX_TODOS} items, got {}",
            todos.len()
        ));
    }

    let mut truncated = 0usize;
    let mut items = Vec::with_capacity(todos.len());
    for (index, item) in todos.iter().enumerate() {
        let (item, was_truncated) = normalize_item(item, index)?;
        if was_truncated {
            truncated += 1;
        }
        items.push(item);
    }

    let mut warnings = Vec::new();
    if truncated > 0 {
        warnings.push(format!(
            "{truncated} item(s) were truncated to {MAX_TODO_CONTENT_CHARS} characters"
        ));
    }
    if let Some(first) = items
        .iter()
        .position(|item| item.status == STATUS_IN_PROGRESS)
    {
        let mut demoted = false;
        for item in items.iter_mut().skip(first + 1) {
            if item.status == STATUS_IN_PROGRESS {
                item.status = STATUS_PENDING.to_string();
                demoted = true;
            }
        }
        if demoted {
            warnings.push(
                "only the first in_progress item is kept; later ones became pending".to_string(),
            );
        }
    }

    Ok(NormalizedTodos { items, warnings })
}

fn normalize_item(value: &Value, index: usize) -> Result<(TodoItem, bool)> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("todos[{index}] must be an object"))?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("todos[{index}].content must be a string"))?
        .trim();
    if content.is_empty() {
        return Err(anyhow!("todos[{index}].content must not be empty"));
    }
    if content.contains('\0') {
        return Err(anyhow!(
            "todos[{index}].content must not contain NUL characters"
        ));
    }
    let (content, truncated) = if content.chars().count() > MAX_TODO_CONTENT_CHARS {
        let clipped: String = content.chars().take(MAX_TODO_CONTENT_CHARS).collect();
        (clipped, true)
    } else {
        (content.to_string(), false)
    };

    let status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("todos[{index}].status must be a string"))?;
    if !TODO_STATUSES.contains(&status) {
        return Err(anyhow!(
            "todos[{index}].status must be one of {}",
            TODO_STATUSES.join(", ")
        ));
    }

    // A missing priority defaults to medium; an explicitly non-string or
    // unknown priority is a mistake the model can fix, not something to
    // silently repair.
    let priority = match object.get("priority") {
        None => PRIORITY_MEDIUM,
        Some(Value::String(priority)) if TODO_PRIORITIES.contains(&priority.as_str()) => {
            priority.as_str()
        }
        Some(_) => {
            return Err(anyhow!(
                "todos[{index}].priority must be one of {}",
                TODO_PRIORITIES.join(", ")
            ));
        }
    };

    Ok((
        TodoItem {
            content,
            status: status.to_string(),
            priority: priority.to_string(),
        },
        truncated,
    ))
}

/// Read the committed snapshot for a live session. `None` covers both an
/// unknown id and a row already marked deleted; the caller decides which wire
/// error that is.
pub fn get(db: &Database, session_id: &str) -> Result<Option<TodoSnapshot>> {
    let tx = db.conn().unchecked_transaction()?;
    let snapshot = read_tx(&tx, session_id)?;
    // A deferred read transaction holds one snapshot across the revision row
    // and the item rows, so a concurrent replace cannot pair an old list with
    // a new revision.
    drop(tx);
    Ok(snapshot)
}

fn read_tx(tx: &Transaction<'_>, session_id: &str) -> Result<Option<TodoSnapshot>> {
    let session: Option<(i64, Option<i64>)> = tx
        .query_row(
            "SELECT todo_revision, todo_updated_at FROM sessions
              WHERE id = ?1 AND deleted_at IS NULL",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((revision, updated_at)) = session else {
        return Ok(None);
    };
    let mut stmt = tx.prepare(
        "SELECT content, status, priority FROM session_todo
          WHERE session_id = ?1 ORDER BY position ASC",
    )?;
    let todos = stmt
        .query_map(params![session_id], |row| {
            Ok(TodoItem {
                content: row.get(0)?,
                status: row.get(1)?,
                priority: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(TodoSnapshot {
        session_id: session_id.to_string(),
        todos,
        revision,
        updated_at: updated_at.unwrap_or(0),
    }))
}

/// Replace a session's checklist from one `TodoWrite` call.
///
/// The session's live state, its durable `agent` mode, and the owning running
/// turn are re-read *inside* the writing transaction. Permission evaluation,
/// the user's approval, and tool admission all await between the RPC entry
/// point and this call, so anything that authorized the call may have moved
/// on: a soft-deleted session, a switched mode, or an ended turn must not
/// still be able to write.
///
/// The item replacement and the `todo_revision` / `todo_updated_at` bump share
/// one transaction, so a failed write cannot advance the revision.
pub fn replace_for_turn(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    normalized: &NormalizedTodos,
) -> Result<TodoSnapshot, TodoWriteError> {
    let tx = db.conn().unchecked_transaction()?;
    let snapshot = replace_tx(&tx, session_id, turn_id, normalized)?;
    tx.commit()?;
    Ok(snapshot)
}

fn replace_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    turn_id: Option<&str>,
    normalized: &NormalizedTodos,
) -> Result<TodoSnapshot, TodoWriteError> {
    let session: Option<(String, Option<i64>)> = tx
        .query_row(
            "SELECT mode, deleted_at FROM sessions WHERE id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((mode, deleted_at)) = session else {
        return Err(TodoWriteError::Refused(TodoRefusal::SessionNotFound));
    };
    if deleted_at.is_some() {
        return Err(TodoWriteError::Refused(TodoRefusal::SessionNotFound));
    }
    if crate::sessions::normalize_mode(Some(&mode)) != "agent" {
        return Err(TodoWriteError::Refused(TodoRefusal::SessionNotAgent));
    }

    let Some(turn_id) = turn_id else {
        return Err(TodoWriteError::Refused(TodoRefusal::TurnMissing));
    };
    let turn_status: Option<String> = tx
        .query_row(
            "SELECT status FROM turns WHERE id = ?1 AND session_id = ?2",
            params![turn_id, session_id],
            |row| row.get(0),
        )
        .optional()?;
    if turn_status.as_deref() != Some("running") {
        return Err(TodoWriteError::Refused(TodoRefusal::TurnNotRunning));
    }

    let now = now_ms();
    let revision: i64 = tx.query_row(
        "UPDATE sessions SET todo_revision = todo_revision + 1, todo_updated_at = ?2
          WHERE id = ?1 RETURNING todo_revision",
        params![session_id, now],
        |row| row.get(0),
    )?;
    tx.execute(
        "DELETE FROM session_todo WHERE session_id = ?1",
        params![session_id],
    )?;
    for (position, item) in normalized.items.iter().enumerate() {
        tx.execute(
            "INSERT INTO session_todo
               (session_id, position, content, status, priority, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session_id,
                position as i64,
                item.content,
                item.status,
                item.priority,
                now
            ],
        )?;
    }
    Ok(TodoSnapshot {
        session_id: session_id.to_string(),
        todos: normalized.items.clone(),
        revision,
        updated_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;
    use serde_json::json;

    fn db() -> Database {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep().join("pi.sqlite");
        Database::open(&path).unwrap()
    }

    fn session(db: &Database) -> String {
        sessions::create_session(db, Some("todos".into()), None, None, None, None)
            .unwrap()
            .id
    }

    fn normalized(value: Value) -> NormalizedTodos {
        normalize_input(&value).unwrap()
    }

    fn write(db: &Database, session_id: &str, value: Value) -> TodoSnapshot {
        let turn = sessions::begin_turn(db, session_id, None, None).unwrap();
        let snapshot = replace_for_turn(db, session_id, Some(&turn), &normalized(value)).unwrap();
        sessions::end_turn(db, &turn, "completed", None, None, false).unwrap();
        snapshot
    }

    #[test]
    fn normalization_trims_defaults_priority_and_keeps_only_one_active_item() {
        let normalized = normalize_input(&json!({
            "todos": [
                {"content": "  first  ", "status": "in_progress"},
                {"content": "second", "status": "in_progress", "priority": "high"}
            ]
        }))
        .unwrap();
        assert_eq!(normalized.items[0].content, "first");
        assert_eq!(normalized.items[0].priority, PRIORITY_MEDIUM);
        assert_eq!(normalized.items[1].status, STATUS_PENDING);
        assert_eq!(normalized.items[1].priority, PRIORITY_HIGH);
        assert_eq!(normalized.warnings.len(), 1);
        assert!(normalized.warnings[0].contains("in_progress"));
    }

    #[test]
    fn normalization_truncates_over_long_unicode_content_with_a_warning() {
        let over = "日".repeat(MAX_TODO_CONTENT_CHARS + 1);
        let normalized = normalize_input(&json!({
            "todos": [{"content": over, "status": "pending"}]
        }))
        .unwrap();
        assert_eq!(
            normalized.items[0].content.chars().count(),
            MAX_TODO_CONTENT_CHARS
        );
        assert_eq!(normalized.warnings.len(), 1);
        assert!(normalized.warnings[0].contains("truncated"));

        // The boundary itself is kept verbatim: exactly 500 characters is not
        // over the limit.
        let exact = "日".repeat(MAX_TODO_CONTENT_CHARS);
        let normalized = normalize_input(&json!({
            "todos": [{"content": exact, "status": "pending"}]
        }))
        .unwrap();
        assert_eq!(
            normalized.items[0].content.chars().count(),
            MAX_TODO_CONTENT_CHARS
        );
        assert!(normalized.warnings.is_empty());
        // Multi-byte content must not be measured in bytes.
        assert_eq!(normalized.items[0].content, exact);
    }

    #[test]
    fn normalization_rejects_invalid_payloads_without_a_partial_list() {
        for value in [
            json!({}),
            json!({"todos": "nope"}),
            json!({"todos": [{"content": "  ", "status": "pending"}]}),
            json!({"todos": [{"content": "nul\0here", "status": "pending"}]}),
            json!({"todos": [{"content": 7, "status": "pending"}]}),
            json!({"todos": [{"content": "x"}]}),
            json!({"todos": [{"content": "x", "status": "doing"}]}),
            json!({"todos": [{"content": "x", "status": "pending", "priority": null}]}),
            json!({"todos": [{"content": "x", "status": "pending", "priority": 3}]}),
            json!({"todos": [{"content": "x", "status": "pending", "priority": "urgent"}]}),
        ] {
            assert!(
                normalize_input(&value).is_err(),
                "payload must be rejected: {value}"
            );
        }

        // Arguments the transport owns are refused instead of ignored.
        for value in [
            json!({"todos": [], "sessionId": "other"}),
            json!({"todos": [], "turnId": "other"}),
        ] {
            let error = normalize_input(&value).unwrap_err().to_string();
            assert!(error.contains("does not accept"), "{error}");
        }

        // 51 items is over the cap; 50 items is exactly the cap.
        let item = json!({"content": "task", "status": "pending"});
        let over = json!({"todos": vec![item.clone(); MAX_TODOS + 1]});
        assert!(normalize_input(&over).is_err());
        let at_cap = json!({"todos": vec![item; MAX_TODOS]});
        assert_eq!(normalize_input(&at_cap).unwrap().items.len(), MAX_TODOS);
    }

    #[test]
    fn replace_preserves_order_and_clearing_advances_the_revision() {
        let db = db();
        let session_id = session(&db);
        let snapshot = write(
            &db,
            &session_id,
            json!({"todos": [
                {"content": "one", "status": "pending"},
                {"content": "two", "status": "in_progress"},
                {"content": "three", "status": "cancelled", "priority": "low"}
            ]}),
        );
        assert_eq!(snapshot.revision, 1);
        assert!(snapshot.updated_at > 0);
        let stored = get(&db, &session_id).unwrap().unwrap();
        assert_eq!(
            stored
                .todos
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three"]
        );
        assert_eq!(stored.todos[2].priority, PRIORITY_LOW);

        let cleared = write(&db, &session_id, json!({"todos": []}));
        assert_eq!(cleared.revision, 2);
        assert!(cleared.todos.is_empty());
        assert!(get(&db, &session_id).unwrap().unwrap().todos.is_empty());

        let replaced = write(
            &db,
            &session_id,
            json!({"todos": [{"content": "only", "status": "pending"}]}),
        );
        assert_eq!(replaced.revision, 3);
        assert_eq!(get(&db, &session_id).unwrap().unwrap().todos.len(), 1);
    }

    #[test]
    fn checklist_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let session_id = {
            let db = Database::open(&path).unwrap();
            let session_id = session(&db);
            write(
                &db,
                &session_id,
                json!({"todos": [{"content": "durable", "status": "completed"}]}),
            );
            session_id
        };
        let reopened = Database::open(&path).unwrap();
        let stored = get(&reopened, &session_id).unwrap().unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.todos[0].content, "durable");
        assert_eq!(stored.todos[0].status, STATUS_COMPLETED);
    }

    #[test]
    fn a_failure_inside_the_transaction_rolls_back_items_and_revision() {
        let db = db();
        let session_id = session(&db);
        write(
            &db,
            &session_id,
            json!({"todos": [{"content": "keep", "status": "pending"}]}),
        );
        // Injected mid-transaction failure: the second inserted row aborts, so
        // the delete, the revision bump, and the first insert must all roll
        // back together.
        db.conn()
            .execute_batch(
                "CREATE TRIGGER fail_second_item BEFORE INSERT ON session_todo
                 WHEN NEW.position = 1
                 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            )
            .unwrap();
        let turn = sessions::begin_turn(&db, &session_id, None, None).unwrap();
        let error = replace_for_turn(
            &db,
            &session_id,
            Some(&turn),
            &normalized(json!({"todos": [
                {"content": "first", "status": "pending"},
                {"content": "second", "status": "pending"}
            ]})),
        )
        .unwrap_err();
        assert!(matches!(error, TodoWriteError::Internal(_)), "{error}");
        db.conn()
            .execute_batch("DROP TRIGGER fail_second_item")
            .unwrap();

        let stored = get(&db, &session_id).unwrap().unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.todos.len(), 1);
        assert_eq!(stored.todos[0].content, "keep");
    }

    #[test]
    fn deleting_a_session_cascades_its_checklist_and_spares_its_neighbour() {
        let db = db();
        let first = session(&db);
        let second = session(&db);
        write(
            &db,
            &first,
            json!({"todos": [{"content": "first", "status": "pending"}]}),
        );
        write(
            &db,
            &second,
            json!({"todos": [{"content": "second", "status": "pending"}]}),
        );

        assert!(sessions::delete_session(&db, &first).unwrap());
        assert!(get(&db, &first).unwrap().is_none());
        let stored = get(&db, &second).unwrap().unwrap();
        assert_eq!(stored.todos.len(), 1);
        assert_eq!(stored.todos[0].content, "second");
        for orphan in ["session_todo", "turns"] {
            let count: i64 = db
                .conn()
                .query_row(&format!("SELECT COUNT(*) FROM {orphan}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1, "{orphan} kept exactly the surviving session");
        }
    }

    #[test]
    fn a_forked_session_starts_empty_at_revision_zero() {
        let db = db();
        let source = session(&db);
        write(
            &db,
            &source,
            json!({"todos": [{"content": "source item", "status": "pending"}]}),
        );
        let sessions::ForkSessionResult::Created(child) =
            sessions::fork_session_through(&db, &source, None, None).unwrap()
        else {
            panic!("expected a forked session");
        };

        let fork = get(&db, &child.summary.id).unwrap().unwrap();
        assert!(fork.todos.is_empty());
        assert_eq!(fork.revision, 0);
        assert_eq!(fork.updated_at, 0);
        // The source keeps its own list and revision.
        assert_eq!(get(&db, &source).unwrap().unwrap().revision, 1);
    }

    /// The refusal behind a failed write. `TodoWriteError` carries an
    /// `anyhow::Error`, which is not comparable, so tests compare the
    /// authorization outcome instead.
    fn refusal(error: TodoWriteError) -> TodoRefusal {
        match error {
            TodoWriteError::Refused(refusal) => refusal,
            TodoWriteError::Internal(error) => panic!("expected a refusal, got {error}"),
        }
    }

    #[test]
    fn writes_are_refused_for_ineligible_sessions_and_turns() {
        let db = db();
        let agent = session(&db);
        let turn = sessions::begin_turn(&db, &agent, None, None).unwrap();
        let payload = normalized(json!({"todos": [{"content": "x", "status": "pending"}]}));

        // Unknown session.
        assert_eq!(
            refusal(replace_for_turn(&db, "missing", Some(&turn), &payload).unwrap_err()),
            TodoRefusal::SessionNotFound
        );
        // Plan and Goal never write a checklist.
        for mode in ["plan", "goal"] {
            let planned = sessions::create_session(
                &db,
                Some("plan".into()),
                Some(mode.into()),
                None,
                None,
                None,
            )
            .unwrap();
            let planned_turn = sessions::begin_turn(&db, &planned.id, None, None).unwrap();
            assert_eq!(
                refusal(
                    replace_for_turn(&db, &planned.id, Some(&planned_turn), &payload).unwrap_err()
                ),
                TodoRefusal::SessionNotAgent
            );
        }
        // Missing, unknown, foreign, and ended turns are all refusals.
        assert_eq!(
            refusal(replace_for_turn(&db, &agent, None, &payload).unwrap_err()),
            TodoRefusal::TurnMissing
        );
        assert_eq!(
            refusal(replace_for_turn(&db, &agent, Some("unknown-turn"), &payload).unwrap_err()),
            TodoRefusal::TurnNotRunning
        );
        let other = session(&db);
        let other_turn = sessions::begin_turn(&db, &other, None, None).unwrap();
        assert_eq!(
            refusal(replace_for_turn(&db, &agent, Some(&other_turn), &payload).unwrap_err()),
            TodoRefusal::TurnNotRunning
        );
        sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
        assert_eq!(
            refusal(replace_for_turn(&db, &agent, Some(&turn), &payload).unwrap_err()),
            TodoRefusal::TurnNotRunning
        );
        // Nothing above mutated anything.
        assert!(get(&db, &agent).unwrap().unwrap().todos.is_empty());
        assert_eq!(get(&db, &agent).unwrap().unwrap().revision, 0);

        // A soft-deleted session is as unavailable as an unknown one.
        db.conn()
            .execute(
                "UPDATE sessions SET deleted_at = ?2 WHERE id = ?1",
                params![other, now_ms()],
            )
            .unwrap();
        assert!(get(&db, &other).unwrap().is_none());
        assert_eq!(
            refusal(replace_for_turn(&db, &other, Some(&other_turn), &payload).unwrap_err()),
            TodoRefusal::SessionNotFound
        );
    }

    #[test]
    fn the_database_rejects_out_of_contract_rows() {
        let db = db();
        let session_id = session(&db);
        let insert = |content: &str, position: i64, status: &str, priority: &str| {
            db.conn()
                .execute(
                    "INSERT INTO session_todo
                       (session_id, position, content, status, priority, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                    params![session_id, position, content, status, priority],
                )
                .map(|_| ())
        };
        assert!(insert("ok", 0, "pending", "medium").is_ok());
        assert!(insert("", 1, "pending", "medium").is_err());
        assert!(insert("nul\0byte", 2, "pending", "medium").is_err());
        assert!(insert(
            &"x".repeat(MAX_TODO_CONTENT_CHARS + 1),
            3,
            "pending",
            "medium"
        )
        .is_err());
        assert!(insert("x", -1, "pending", "medium").is_err());
        assert!(insert("x", MAX_TODOS as i64, "pending", "medium").is_err());
        assert!(insert("x", 4, "done", "medium").is_err());
        assert!(insert("x", 5, "pending", "urgent").is_err());
        // The partial unique index keeps a single active item even for a write
        // that never went through normalization.
        assert!(insert("active", 6, "in_progress", "medium").is_ok());
        assert!(insert("second active", 7, "in_progress", "medium").is_err());
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM session_todo", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }
}
