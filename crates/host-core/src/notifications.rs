mod pending_completions;

#[cfg(test)]
mod pending_completion_tests;

pub use pending_completions::list_pending_completions;

use anyhow::Result;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms, Database, NOTIFICATION_KEEP};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub kind: String,
    pub session_id: String,
    pub session_title: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

fn notification_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Notification> {
    Ok(Notification {
        id: row.get(0)?,
        kind: row.get(1)?,
        session_id: row.get(2)?,
        session_title: row.get(3)?,
        turn_id: row.get(4)?,
        error_code: row.get(5)?,
        created_at: ms_to_ts(row.get(6)?),
        read_at: row.get::<_, Option<i64>>(7)?.map(ms_to_ts),
    })
}

const NOTIFICATION_SELECT: &str =
    "SELECT n.id, n.kind, n.session_id, n.session_title, n.turn_id, n.error_code,
            n.created_at, n.read_at
     FROM notifications n";

/// Insert the durable fact for a newly terminal turn. The caller owns the
/// transaction so the turn update and notification cannot diverge.
pub fn insert_for_terminal_turn(
    tx: &Transaction<'_>,
    turn_id: &str,
    status: &str,
    error_code: Option<&str>,
) -> Result<Option<Notification>> {
    let kind = match status {
        "completed" => "task.completed",
        "error" => "task.failed",
        _ => return Ok(None),
    };
    let Some((session_id, session_title)) = tx
        .query_row(
            "SELECT t.session_id, s.title
             FROM turns t JOIN sessions s ON s.id = t.session_id
             WHERE t.id = ?1",
            params![turn_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };

    let id = Uuid::new_v4().to_string();
    let created_at = now_ms();
    let inserted = tx
        .prepare_cached(
            "INSERT INTO notifications
                (id, kind, session_id, session_title, turn_id, error_code, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(turn_id) DO NOTHING",
        )?
        .execute(params![
            id,
            kind,
            session_id,
            session_title,
            turn_id,
            error_code,
            created_at
        ])?;
    if inserted == 0 {
        return Ok(None);
    }

    tx.execute(
        "DELETE FROM notifications
         WHERE id IN (
           SELECT id FROM notifications
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?1
         )",
        params![NOTIFICATION_KEEP],
    )?;

    let notification = Notification {
        id,
        kind: kind.to_string(),
        session_id,
        session_title,
        turn_id: turn_id.to_string(),
        error_code: error_code.map(str::to_string),
        created_at: ms_to_ts(created_at),
        read_at: None,
    };
    pending_completions::insert(tx, &notification, created_at)?;
    Ok(Some(notification))
}

pub fn list(db: &Database, unread_only: bool, limit: i64) -> Result<(Vec<Notification>, i64)> {
    let limit = limit.clamp(1, NOTIFICATION_KEEP);
    let sql = if unread_only {
        format!(
            "{NOTIFICATION_SELECT}
             WHERE n.read_at IS NULL
             ORDER BY n.created_at DESC, n.id DESC LIMIT ?1"
        )
    } else {
        format!(
            "{NOTIFICATION_SELECT}
             ORDER BY n.created_at DESC, n.id DESC LIMIT ?1"
        )
    };
    let mut stmt = db.conn().prepare_cached(&sql)?;
    let rows = stmt.query_map(params![limit], notification_from_row)?;
    let notifications = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let unread_count = db.conn().query_row(
        "SELECT COUNT(*) FROM notifications WHERE read_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    Ok((notifications, unread_count))
}

pub fn mark_read(db: &Database, id: &str) -> Result<bool> {
    let tx = db.conn().unchecked_transaction()?;
    let updated = tx
        .prepare_cached("UPDATE notifications SET read_at = COALESCE(read_at, ?1) WHERE id = ?2")?
        .execute(params![now_ms(), id])?;
    let acknowledged = pending_completions::acknowledge(&tx, id)?;
    tx.commit()?;
    Ok(updated > 0 || acknowledged)
}

pub fn mark_all_read(db: &Database) -> Result<()> {
    let tx = db.conn().unchecked_transaction()?;
    tx.prepare_cached("UPDATE notifications SET read_at = ?1 WHERE read_at IS NULL")?
        .execute(params![now_ms()])?;
    tx.execute("DELETE FROM pending_completion_notifications", [])?;
    tx.commit()?;
    Ok(())
}

pub fn clear(db: &Database) -> Result<()> {
    let tx = db.conn().unchecked_transaction()?;
    tx.execute("DELETE FROM notifications", [])?;
    tx.execute("DELETE FROM pending_completion_notifications", [])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn list_read_and_clear_lifecycle() {
        let db = test_db();
        let session =
            sessions::create_session(&db, Some("Build release".into()), None, None, None, None)
                .unwrap();
        let completed = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let completed_result =
            sessions::end_turn(&db, &completed, "completed", None, None, true).unwrap();
        assert_eq!(
            completed_result.notification.unwrap().kind,
            "task.completed"
        );
        let failed = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let failed_result =
            sessions::end_turn(&db, &failed, "error", Some("MODEL_ERROR"), None, true).unwrap();
        assert_eq!(failed_result.notification.unwrap().kind, "task.failed");
        assert!(sessions::rename_session(&db, &session.id, "Renamed session").unwrap());

        let (all, unread) = list(&db, false, 50).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(unread, 2);
        let failed_notification = all
            .iter()
            .find(|notification| notification.kind == "task.failed")
            .unwrap();
        assert_eq!(failed_notification.session_title, "Build release");
        assert_eq!(
            failed_notification.error_code.as_deref(),
            Some("MODEL_ERROR")
        );

        assert!(mark_read(&db, &failed_notification.id).unwrap());
        assert!(!mark_read(&db, "missing").unwrap());
        let (unread_items, unread) = list(&db, true, 50).unwrap();
        assert_eq!(unread_items.len(), 1);
        assert_eq!(unread, 1);

        mark_all_read(&db).unwrap();
        assert_eq!(list(&db, true, 50).unwrap().1, 0);
        clear(&db).unwrap();
        assert!(list(&db, false, 50).unwrap().0.is_empty());
    }

    #[test]
    fn terminal_turns_keep_only_the_latest_two_hundred_notifications() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let db = Database::open(&path).unwrap();
        let session =
            sessions::create_session(&db, Some("Long task".into()), None, None, None, None)
                .unwrap();

        for _ in 0..201 {
            let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
            let result = sessions::end_turn(&db, &turn, "completed", None, None, true).unwrap();
            assert!(result.notification.is_some());
        }

        let stored: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, NOTIFICATION_KEEP);
        assert_eq!(list(&db, false, 500).unwrap().0.len(), 200);

        drop(db);
        let reopened = Database::open(&path).unwrap();
        let stored_after_restart: i64 = reopened
            .conn()
            .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored_after_restart, NOTIFICATION_KEEP);
    }
}
