//! The Host-owned turn queue (D375 / ADR 0213, schema v15).
//!
//! Queued prompts used to live in renderer memory, so only the window that
//! typed them knew they existed and a reload dropped them. The table lets the
//! headless Agent Host restore a session's queue in order after a restart and
//! hold it until a controller attaches, and lets every client see the same
//! pending prompts. The Host never starts a restored entry on its own.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms, Database};

/// Initial target from the RACP limits table (spec §12).
pub const MAX_QUEUED_TURNS_PER_SESSION: i64 = 8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurnInput {
    /// Client-chosen id (the RACP turn id); minted when absent.
    pub id: Option<String>,
    pub session_id: String,
    pub principal: String,
    pub idempotency_key: Option<String>,
    pub input_hash: String,
    pub content: String,
    pub attachments: Option<Value>,
    pub permission_mode: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub id: String,
    pub session_id: String,
    pub principal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub input_hash: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Value>,
    pub permission_mode: String,
    pub position: i64,
    pub created_at: String,
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueuedTurn> {
    let attachments: Option<String> = row.get(6)?;
    Ok(QueuedTurn {
        id: row.get(0)?,
        session_id: row.get(1)?,
        principal: row.get(2)?,
        idempotency_key: row.get(3)?,
        input_hash: row.get(4)?,
        content: row.get(5)?,
        attachments: attachments.and_then(|text| serde_json::from_str(&text).ok()),
        permission_mode: row.get(7)?,
        position: row.get(8)?,
        created_at: ms_to_ts(row.get::<_, i64>(9)?),
    })
}

const SELECT: &str = "SELECT id, session_id, principal, idempotency_key, input_hash, content,
        attachments_json, permission_mode, position, created_at
 FROM turn_queue";

/// Append an entry. A reused `(session, principal, idempotencyKey)` returns
/// the existing entry when the input hash matches and fails with
/// `IDEMPOTENCY_CONFLICT` otherwise; a full queue fails with `QUEUE_FULL`.
pub fn push(db: &Database, input: QueuedTurnInput) -> Result<QueuedTurn> {
    let conn = db.conn();
    let session_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
        params![input.session_id],
        |row| row.get(0),
    )?;
    if !session_exists {
        return Err(anyhow!("session not found: {}", input.session_id));
    }
    if let Some(key) = input.idempotency_key.as_deref() {
        let existing = conn
            .prepare_cached(&format!(
                "{SELECT} WHERE session_id = ?1 AND principal = ?2 AND idempotency_key = ?3"
            ))?
            .query_row(params![input.session_id, input.principal, key], row_to_entry)
            .optional()?;
        if let Some(existing) = existing {
            if existing.input_hash == input.input_hash {
                return Ok(existing);
            }
            return Err(anyhow!("IDEMPOTENCY_CONFLICT"));
        }
    }
    let tx = conn.unchecked_transaction()?;
    let (count, max_position): (i64, i64) = tx.query_row(
        "SELECT COUNT(*), COALESCE(MAX(position), 0) FROM turn_queue WHERE session_id = ?1",
        params![input.session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if count >= MAX_QUEUED_TURNS_PER_SESSION {
        return Err(anyhow!("QUEUE_FULL"));
    }
    let id = input
        .id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let attachments_json = input
        .attachments
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let created_at = now_ms();
    tx.execute(
        "INSERT INTO turn_queue (
            id, session_id, principal, idempotency_key, input_hash, content,
            attachments_json, permission_mode, position, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            input.session_id,
            input.principal,
            input.idempotency_key,
            input.input_hash,
            input.content,
            attachments_json,
            input.permission_mode,
            max_position + 1,
            created_at
        ],
    )?;
    tx.commit()?;
    Ok(QueuedTurn {
        id,
        session_id: input.session_id,
        principal: input.principal,
        idempotency_key: input.idempotency_key,
        input_hash: input.input_hash,
        content: input.content,
        attachments: input.attachments,
        permission_mode: input.permission_mode,
        position: max_position + 1,
        created_at: ms_to_ts(created_at),
    })
}

/// Entries in queue order, for one session or for every session.
pub fn list(db: &Database, session_id: Option<&str>) -> Result<Vec<QueuedTurn>> {
    let conn = db.conn();
    let entries = match session_id {
        Some(session_id) => conn
            .prepare_cached(&format!(
                "{SELECT} WHERE session_id = ?1 ORDER BY position ASC"
            ))?
            .query_map(params![session_id], row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        None => conn
            .prepare_cached(&format!("{SELECT} ORDER BY session_id ASC, position ASC"))?
            .query_map([], row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok(entries)
}

/// Remove one entry; `false` when it was not queued. Positions of the
/// remaining entries keep their relative order.
pub fn remove(db: &Database, id: &str) -> Result<bool> {
    let removed = db
        .conn()
        .prepare_cached("DELETE FROM turn_queue WHERE id = ?1")?
        .execute(params![id])?;
    Ok(removed > 0)
}

/// Move one entry to the head of its session's queue ("send now"). The entry
/// takes a position below the current minimum, so nothing else is rewritten.
pub fn prioritize(db: &Database, id: &str) -> Result<Option<QueuedTurn>> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let Some(session_id) = tx
        .prepare_cached("SELECT session_id FROM turn_queue WHERE id = ?1")?
        .query_row(params![id], |row| row.get::<_, String>(0))
        .optional()?
    else {
        return Ok(None);
    };
    let min_position: i64 = tx.query_row(
        "SELECT COALESCE(MIN(position), 0) FROM turn_queue WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "UPDATE turn_queue SET position = ?1 WHERE id = ?2",
        params![min_position - 1, id],
    )?;
    let entry = tx
        .prepare_cached(&format!("{SELECT} WHERE id = ?1"))?
        .query_row(params![id], row_to_entry)?;
    tx.commit()?;
    Ok(Some(entry))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    fn open_with_session() -> (tempfile::TempDir, Database, String) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let session = sessions::create_session(
            &db,
            Some("Queue".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        (dir, db, session.id)
    }

    fn input(session_id: &str, content: &str, key: Option<&str>) -> QueuedTurnInput {
        QueuedTurnInput {
            id: None,
            session_id: session_id.to_string(),
            principal: "desktop".into(),
            idempotency_key: key.map(str::to_string),
            input_hash: format!("hash:{content}"),
            content: content.to_string(),
            attachments: None,
            permission_mode: "ask".into(),
        }
    }

    #[test]
    fn push_keeps_order_positions_and_the_bound() {
        let (_dir, db, session_id) = open_with_session();
        let first = push(&db, input(&session_id, "one", None)).unwrap();
        let second = push(&db, input(&session_id, "two", None)).unwrap();
        assert_eq!(first.position, 1);
        assert_eq!(second.position, 2);
        assert!(!first.created_at.is_empty());
        let listed = list(&db, Some(&session_id)).unwrap();
        assert_eq!(listed.iter().map(|e| e.content.as_str()).collect::<Vec<_>>(), ["one", "two"]);
        assert!(remove(&db, &first.id).unwrap());
        assert!(!remove(&db, &first.id).unwrap());
        assert_eq!(list(&db, None).unwrap().len(), 1);
        for index in 0..MAX_QUEUED_TURNS_PER_SESSION - 1 {
            push(&db, input(&session_id, &format!("fill {index}"), None)).unwrap();
        }
        let full = push(&db, input(&session_id, "overflow", None)).unwrap_err();
        assert_eq!(full.to_string(), "QUEUE_FULL");
    }

    #[test]
    fn push_is_idempotent_per_principal_and_key() {
        let (_dir, db, session_id) = open_with_session();
        let first = push(&db, input(&session_id, "same", Some("k1"))).unwrap();
        let again = push(&db, input(&session_id, "same", Some("k1"))).unwrap();
        assert_eq!(first, again);
        let conflict = push(&db, input(&session_id, "different", Some("k1"))).unwrap_err();
        assert_eq!(conflict.to_string(), "IDEMPOTENCY_CONFLICT");
        assert_eq!(list(&db, Some(&session_id)).unwrap().len(), 1);
    }

    #[test]
    fn push_rejects_an_unknown_session_and_keeps_a_client_id() {
        let (_dir, db, session_id) = open_with_session();
        let missing = push(&db, input("nope", "x", None)).unwrap_err();
        assert!(missing.to_string().starts_with("session not found"));
        let mut chosen = input(&session_id, "x", None);
        chosen.id = Some("turn_client_1".into());
        chosen.attachments = Some(serde_json::json!([{ "name": "a.txt" }]));
        let entry = push(&db, chosen).unwrap();
        assert_eq!(entry.id, "turn_client_1");
        assert_eq!(list(&db, Some(&session_id)).unwrap()[0].attachments, entry.attachments);
    }

    #[test]
    fn prioritize_moves_an_entry_to_the_head() {
        let (_dir, db, session_id) = open_with_session();
        push(&db, input(&session_id, "one", None)).unwrap();
        let second = push(&db, input(&session_id, "two", None)).unwrap();
        push(&db, input(&session_id, "three", None)).unwrap();
        let moved = prioritize(&db, &second.id).unwrap().unwrap();
        assert!(moved.position < 1);
        let order: Vec<String> = list(&db, Some(&session_id))
            .unwrap()
            .into_iter()
            .map(|entry| entry.content)
            .collect();
        assert_eq!(order, ["two", "one", "three"]);
        assert!(prioritize(&db, "missing").unwrap().is_none());
    }

    #[test]
    fn deleting_the_session_drops_its_queue() {
        let (_dir, db, session_id) = open_with_session();
        push(&db, input(&session_id, "one", None)).unwrap();
        db.conn()
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .unwrap();
        assert!(list(&db, None).unwrap().is_empty());
    }
}
