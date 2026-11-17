//! Completion attention has its own lifetime, independent of bounded inbox history.

use anyhow::Result;
use rusqlite::{params, Transaction};

use super::Notification;
use crate::db::{ms_to_ts, Database, NOTIFICATION_KEEP};

pub(super) fn insert(
    tx: &Transaction<'_>,
    notification: &Notification,
    created_at: i64,
) -> Result<()> {
    if notification.kind != "task.completed" {
        return Ok(());
    }
    tx.prepare_cached(
        "INSERT INTO pending_completion_notifications
            (id, session_id, session_title, turn_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(turn_id) DO NOTHING",
    )?
    .execute(params![
        notification.id,
        notification.session_id,
        notification.session_title,
        notification.turn_id,
        created_at
    ])?;
    Ok(())
}

pub fn list_pending_completions(
    db: &Database,
    limit: i64,
    offset: i64,
) -> Result<(Vec<Notification>, i64)> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT id, session_id, session_title, turn_id, created_at
         FROM pending_completion_notifications
         ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(
        params![limit.clamp(1, NOTIFICATION_KEEP), offset.max(0)],
        |row| {
            Ok(Notification {
                id: row.get(0)?,
                kind: "task.completed".into(),
                session_id: row.get(1)?,
                session_title: row.get(2)?,
                turn_id: row.get(3)?,
                error_code: None,
                created_at: ms_to_ts(row.get(4)?),
                read_at: None,
            })
        },
    )?;
    let notifications = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let count = db.conn().query_row(
        "SELECT COUNT(*) FROM pending_completion_notifications",
        [],
        |row| row.get(0),
    )?;
    Ok((notifications, count))
}

pub(super) fn acknowledge(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    let removed = tx
        .prepare_cached("DELETE FROM pending_completion_notifications WHERE id = ?1")?
        .execute(params![id])?;
    Ok(removed > 0)
}
