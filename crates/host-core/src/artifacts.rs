use anyhow::Result;
use rusqlite::params;
use serde::Serialize;

use crate::db::{ms_to_ts, now_ms, Database};

/// Files a session produced via `write`/`edit` tools (04-data-storage §4.9).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub session_id: String,
    pub session_title: Option<String>,
    pub path: String,
    pub op: String,
    pub updated_at: String,
}

/// Upsert: one row per (session, file); repeat edits refresh op + timestamp.
pub fn record(
    db: &Database,
    session_id: &str,
    path: &str,
    op: &str,
    turn_id: Option<&str>,
) -> Result<()> {
    record_on(db.conn(), session_id, path, op, turn_id)
}

/// Register an artifact as part of the plan submission transaction.
pub fn record_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    path: &str,
    op: &str,
    turn_id: Option<&str>,
) -> Result<()> {
    record_on(tx, session_id, path, op, turn_id)
}

fn record_on(
    conn: &rusqlite::Connection,
    session_id: &str,
    path: &str,
    op: &str,
    turn_id: Option<&str>,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO artifacts (session_id, path, op, turn_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, path) DO UPDATE SET
               op = excluded.op,
               turn_id = COALESCE(excluded.turn_id, artifacts.turn_id),
               updated_at = excluded.updated_at",
    )?
    .execute(params![session_id, path, op, turn_id, now_ms()])?;
    Ok(())
}

pub fn list(db: &Database, session_id: Option<&str>, limit: i64) -> Result<Vec<Artifact>> {
    let limit = limit.clamp(1, 500);
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Artifact> {
        Ok(Artifact {
            session_id: row.get(0)?,
            session_title: row.get(1)?,
            path: row.get(2)?,
            op: row.get(3)?,
            updated_at: ms_to_ts(row.get(4)?),
        })
    };
    let mut out = Vec::new();
    if let Some(session_id) = session_id {
        let mut stmt = db.conn().prepare_cached(
            "SELECT a.session_id, s.title, a.path, a.op, a.updated_at
             FROM artifacts a JOIN sessions s ON s.id = a.session_id
             WHERE a.session_id = ?1
             ORDER BY a.updated_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session_id, limit], map_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    } else {
        let mut stmt = db.conn().prepare_cached(
            "SELECT a.session_id, s.title, a.path, a.op, a.updated_at
             FROM artifacts a JOIN sessions s ON s.id = a.session_id
             ORDER BY a.updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], map_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn record_upserts_per_session_and_path() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        record(&db, &session.id, "/tmp/a.txt", "write", None).unwrap();
        record(&db, &session.id, "/tmp/a.txt", "edit", None).unwrap();
        record(&db, &session.id, "/tmp/b.txt", "write", None).unwrap();
        let all = list(&db, Some(&session.id), 50).unwrap();
        assert_eq!(all.len(), 2);
        let a = all.iter().find(|x| x.path == "/tmp/a.txt").unwrap();
        assert_eq!(a.op, "edit");
        // Session delete cascades.
        sessions::delete_session(&db, &session.id).unwrap();
        assert!(list(&db, None, 50).unwrap().is_empty());
    }
}
