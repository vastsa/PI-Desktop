//! The Host-owned turn queue (D375 / ADR 0213 / ADR 0260, schema v18).
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
    pub composer_display: Option<Value>,
    pub session_message_id: Option<String>,
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
    pub composer_display: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Value>,
    pub permission_mode: String,
    pub position: i64,
    /// Set once the entry is promoted ("send now"). The value is the entry's
    /// place inside the session's priority block, so promotions leave in the
    /// order they were clicked. `None` means the entry was never promoted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
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
        composer_display: row
            .get::<_, Option<String>>(12)?
            .and_then(|text| serde_json::from_str(&text).ok()),
        session_message_id: row.get(10)?,
        attachments: attachments.and_then(|text| serde_json::from_str(&text).ok()),
        permission_mode: row.get(7)?,
        position: row.get(8)?,
        priority: row.get(11)?,
        created_at: ms_to_ts(row.get::<_, i64>(9)?),
    })
}

const SELECT: &str = "SELECT id, session_id, principal, idempotency_key, input_hash, content,
        attachments_json, permission_mode, position, created_at, session_message_id, priority, composer_display_json
 FROM turn_queue";

/// Delivery order: promoted entries first in click order (ascending
/// `priority`), then every remaining entry in queue (`position`) order.
const ORDER_BY: &str = "ORDER BY (priority IS NULL) ASC, priority ASC, position ASC";

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
            .query_row(
                params![input.session_id, input.principal, key],
                row_to_entry,
            )
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
    let composer_display_json = input
        .composer_display
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let created_at = now_ms();
    tx.execute(
        "INSERT INTO turn_queue (
            id, session_id, principal, idempotency_key, input_hash, content,
            attachments_json, permission_mode, position, created_at, session_message_id, composer_display_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
            created_at,
            input.session_message_id,
            composer_display_json
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
        composer_display: input.composer_display,
        session_message_id: input.session_message_id,
        attachments: input.attachments,
        permission_mode: input.permission_mode,
        position: max_position + 1,
        priority: None,
        created_at: ms_to_ts(created_at),
    })
}

/// Entries in delivery order, for one session or for every session: promoted
/// entries first in click order, then the rest by `position`.
pub fn list(db: &Database, session_id: Option<&str>) -> Result<Vec<QueuedTurn>> {
    let conn = db.conn();
    let entries = match session_id {
        Some(session_id) => conn
            .prepare_cached(&format!("{SELECT} WHERE session_id = ?1 {ORDER_BY}"))?
            .query_map(params![session_id], row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        None => conn
            .prepare_cached(&format!("{SELECT} ORDER BY session_id ASC, (priority IS NULL) ASC, priority ASC, position ASC"))?
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

/// Direction of one `reorder` step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReorderDirection {
    Up,
    Down,
}

/// Promote one entry to the end of its session's priority block ("send now").
///
/// The entry gets `COALESCE(MAX(priority), 0) + 1`, so successive promotions
/// are delivered in the order they were requested. Promotion is one-way: an
/// entry that already has a priority is a conflict (`ALREADY_PRIORITIZED`)
/// instead of being moved again. `Ok(None)` means the entry is not queued.
pub fn prioritize(db: &Database, id: &str) -> Result<Option<QueuedTurn>> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let Some((session_id, priority)) = tx
        .prepare_cached("SELECT session_id, priority FROM turn_queue WHERE id = ?1")?
        .query_row(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .optional()?
    else {
        return Ok(None);
    };
    if priority.is_some() {
        return Err(anyhow!("ALREADY_PRIORITIZED"));
    }
    let next_priority: i64 = tx.query_row(
        "SELECT COALESCE(MAX(priority), 0) + 1 FROM turn_queue WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "UPDATE turn_queue SET priority = ?1 WHERE id = ?2",
        params![next_priority, id],
    )?;
    let entry = tx
        .prepare_cached(&format!("{SELECT} WHERE id = ?1"))?
        .query_row(params![id], row_to_entry)?;
    tx.commit()?;
    Ok(Some(entry))
}

/// Swap one entry with its adjacent non-prioritized neighbour in the session.
///
/// Only the plain queue (`position`) moves: a promoted entry keeps its place
/// in the priority block and is never reordered by this path. `Ok(false)` is
/// the no-op result for a missing entry, a promoted entry, or a missing
/// neighbour in that direction.
pub fn reorder(db: &Database, id: &str, direction: ReorderDirection) -> Result<bool> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let Some((session_id, position, priority)) = tx
        .prepare_cached("SELECT session_id, position, priority FROM turn_queue WHERE id = ?1")?
        .query_row(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .optional()?
    else {
        return Ok(false);
    };
    if priority.is_some() {
        return Ok(false);
    }
    let neighbour = match direction {
        ReorderDirection::Up => tx
            .prepare_cached(
                "SELECT id, position FROM turn_queue
                 WHERE session_id = ?1 AND priority IS NULL AND position < ?2
                 ORDER BY position DESC LIMIT 1",
            )?
            .query_row(params![session_id, position], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()?,
        ReorderDirection::Down => tx
            .prepare_cached(
                "SELECT id, position FROM turn_queue
                 WHERE session_id = ?1 AND priority IS NULL AND position > ?2
                 ORDER BY position ASC LIMIT 1",
            )?
            .query_row(params![session_id, position], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()?,
    };
    let Some((neighbour_id, neighbour_position)) = neighbour else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE turn_queue SET position = ?1 WHERE id = ?2",
        params![neighbour_position, id],
    )?;
    tx.execute(
        "UPDATE turn_queue SET position = ?1 WHERE id = ?2",
        params![position, neighbour_id],
    )?;
    tx.commit()?;
    Ok(true)
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
            session_message_id: None,
            composer_display: None,
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
        assert_eq!(
            listed
                .iter()
                .map(|e| e.content.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
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
        assert_eq!(
            list(&db, Some(&session_id)).unwrap()[0].attachments,
            entry.attachments
        );
    }

    fn content_order(db: &Database, session_id: &str) -> Vec<String> {
        list(db, Some(session_id))
            .unwrap()
            .into_iter()
            .map(|entry| entry.content)
            .collect()
    }

    #[test]
    fn prioritize_appends_to_the_priority_block_in_click_order() {
        let (_dir, db, session_id) = open_with_session();
        push(&db, input(&session_id, "one", None)).unwrap();
        let second = push(&db, input(&session_id, "two", None)).unwrap();
        let third = push(&db, input(&session_id, "three", None)).unwrap();
        let promoted = prioritize(&db, &second.id).unwrap().unwrap();
        assert_eq!(promoted.priority, Some(1));
        assert_eq!(promoted.position, 2, "promotion leaves the position alone");
        assert_eq!(content_order(&db, &session_id), ["two", "one", "three"]);
        // A second promotion appends to the block: the first click leaves first.
        let later = prioritize(&db, &third.id).unwrap().unwrap();
        assert_eq!(later.priority, Some(2));
        assert_eq!(content_order(&db, &session_id), ["two", "three", "one"]);
        // Promotion is one-way; promoting twice is a conflict, not a reorder.
        let again = prioritize(&db, &second.id).unwrap_err();
        assert_eq!(again.to_string(), "ALREADY_PRIORITIZED");
        assert_eq!(content_order(&db, &session_id), ["two", "three", "one"]);
        assert!(prioritize(&db, "missing").unwrap().is_none());
    }

    #[test]
    fn reorder_swaps_adjacent_non_prioritized_entries() {
        let (_dir, db, session_id) = open_with_session();
        let first = push(&db, input(&session_id, "one", None)).unwrap();
        let second = push(&db, input(&session_id, "two", None)).unwrap();
        let third = push(&db, input(&session_id, "three", None)).unwrap();
        assert!(!reorder(&db, &first.id, ReorderDirection::Up).unwrap());
        assert!(reorder(&db, &third.id, ReorderDirection::Up).unwrap());
        assert_eq!(content_order(&db, &session_id), ["one", "three", "two"]);
        assert!(reorder(&db, &first.id, ReorderDirection::Down).unwrap());
        assert_eq!(content_order(&db, &session_id), ["three", "one", "two"]);
        assert!(!reorder(&db, &second.id, ReorderDirection::Down).unwrap());
        assert!(!reorder(&db, "missing", ReorderDirection::Up).unwrap());
        assert_eq!(content_order(&db, &session_id), ["three", "one", "two"]);
    }

    #[test]
    fn reorder_never_moves_a_prioritized_entry() {
        let (_dir, db, session_id) = open_with_session();
        let first = push(&db, input(&session_id, "one", None)).unwrap();
        push(&db, input(&session_id, "two", None)).unwrap();
        let third = push(&db, input(&session_id, "three", None)).unwrap();
        prioritize(&db, &third.id).unwrap().unwrap();
        assert_eq!(content_order(&db, &session_id), ["three", "one", "two"]);
        assert!(!reorder(&db, &third.id, ReorderDirection::Down).unwrap());
        assert_eq!(content_order(&db, &session_id), ["three", "one", "two"]);
        // A promoted entry is not a neighbour: `one` is already first in the
        // plain queue, so it cannot move up.
        assert!(!reorder(&db, &first.id, ReorderDirection::Up).unwrap());
        assert!(reorder(&db, &first.id, ReorderDirection::Down).unwrap());
        assert_eq!(content_order(&db, &session_id), ["three", "two", "one"]);
        assert_eq!(
            list(&db, Some(&session_id)).unwrap()[0].priority,
            Some(1),
            "the promoted entry stays at the head of the priority block"
        );
    }

    #[test]
    fn a_v16_queue_upgrades_with_its_rows_and_keeps_working() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let session_id: String;
        let first: QueuedTurn;
        let second: QueuedTurn;
        {
            let db = Database::open(&path).unwrap();
            let session = sessions::create_session(
                &db,
                Some("Queue".into()),
                Some("agent".into()),
                None,
                None,
                None,
            )
            .unwrap();
            session_id = session.id;
            first = push(&db, input(&session_id, "one", None)).unwrap();
            second = push(&db, input(&session_id, "two", None)).unwrap();
            // A v16 database has no priority column yet.
            db.conn()
                .execute_batch("ALTER TABLE turn_queue DROP COLUMN priority;")
                .unwrap();
            db.conn().pragma_update(None, "user_version", 16).unwrap();
        }
        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::db::SCHEMA_VERSION);
        let restored = list(&db, Some(&session_id)).unwrap();
        assert_eq!(
            restored
                .iter()
                .map(|entry| entry.content.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        assert_eq!(
            (restored[0].id.as_str(), restored[1].id.as_str()),
            (first.id.as_str(), second.id.as_str())
        );
        assert!(restored.iter().all(|entry| entry.priority.is_none()));
        // Migrated rows stay usable: promote, append, and reorder after the upgrade.
        prioritize(&db, &second.id).unwrap().unwrap();
        let third = push(&db, input(&session_id, "three", None)).unwrap();
        assert!(reorder(&db, &third.id, ReorderDirection::Up).unwrap());
        assert_eq!(content_order(&db, &session_id), ["two", "three", "one"]);
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
