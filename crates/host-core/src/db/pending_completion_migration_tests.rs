use super::*;
use crate::{notifications, sessions};

fn version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn has_pending_table(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'pending_completion_notifications')",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn populated_v33(path: &Path) {
    let db = Database::open(path).unwrap();
    db.conn().execute_batch(
        "DROP TABLE pending_completion_notifications;
         INSERT INTO sessions(id, title, created_at, updated_at) VALUES ('s', 'Snapshot title', 1, 1);
         INSERT INTO turns(id, session_id, status, started_at, ended_at) VALUES
            ('unread', 's', 'completed', 1, 2),
            ('read', 's', 'completed', 1, 3),
            ('failed', 's', 'error', 1, 4),
            ('read-failed', 's', 'error', 1, 5);
         INSERT INTO notifications(id, kind, session_id, session_title, turn_id, created_at, read_at) VALUES
            ('n-unread', 'task.completed', 's', 'Snapshot title', 'unread', 2, NULL),
            ('n-read', 'task.completed', 's', 'Snapshot title', 'read', 3, 100),
            ('n-failed', 'task.failed', 's', 'Snapshot title', 'failed', 4, NULL),
            ('n-read-failed', 'task.failed', 's', 'Snapshot title', 'read-failed', 5, 101),
            ('n-orphan', 'task.completed', 's', 'Snapshot title', 'missing-turn', 6, NULL);
         PRAGMA user_version = 33;",
    ).unwrap();
}

#[test]
fn pending_completion_migration_v33_backfills_only_owned_unread_completed_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v33(&path);
    let db = Database::open(&path).unwrap();
    assert_eq!(version(db.conn()), 34);
    let (pending, count) = notifications::list_pending_completions(&db, 200, 0).unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        serde_json::to_value(&pending).unwrap(),
        serde_json::json!([{
            "id": "n-unread", "kind": "task.completed", "sessionId": "s",
            "sessionTitle": "Snapshot title", "turnId": "unread", "createdAt": ms_to_ts(2)
        }])
    );
    let (history, unread) = notifications::list(&db, false, 200).unwrap();
    assert_eq!(history.len(), 5);
    assert_eq!(unread, 3);
    assert_eq!(
        history.iter().find(|n| n.id == "n-read").unwrap().read_at,
        Some(ms_to_ts(100))
    );
    assert_eq!(
        history
            .iter()
            .find(|n| n.id == "n-read-failed")
            .unwrap()
            .read_at,
        Some(ms_to_ts(101))
    );
    assert!(!db
        .conn()
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    let backup = Connection::open(migration_backup_path(&path, 33)).unwrap();
    assert_eq!(version(&backup), 33);
    assert!(!has_pending_table(&backup));
    let original_history: Vec<Vec<rusqlite::types::Value>> = backup
        .prepare(
            "SELECT id, kind, session_id, session_title, turn_id, error_code, created_at, read_at
         FROM notifications ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| (0..8).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let upgraded_history: Vec<Vec<rusqlite::types::Value>> = db
        .conn()
        .prepare(
            "SELECT id, kind, session_id, session_title, turn_id, error_code, created_at, read_at
         FROM notifications ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| (0..8).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(original_history, upgraded_history);

    // Explicit acknowledgement must not be recreated on the next launch,
    // even if old unread history remains.
    db.conn()
        .execute("DELETE FROM pending_completion_notifications", [])
        .unwrap();
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        notifications::list_pending_completions(&reopened, 200, 0)
            .unwrap()
            .1,
        0
    );
    assert_eq!(notifications::list(&reopened, true, 200).unwrap().1, 3);
}

fn pending_schema(conn: &Connection) -> Vec<(String, Option<String>)> {
    conn.prepare(
        "SELECT name, sql FROM sqlite_master
         WHERE tbl_name = 'pending_completion_notifications' ORDER BY name",
    )
    .unwrap()
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

#[test]
fn pending_completion_migration_fresh_and_v33_have_identical_schema_and_session_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let fresh = Database::open(&dir.path().join("fresh.sqlite")).unwrap();
    assert_eq!(version(fresh.conn()), 34);
    assert_eq!(
        notifications::list_pending_completions(&fresh, 200, 0)
            .unwrap()
            .1,
        0
    );
    let path = dir.path().join("old.sqlite");
    populated_v33(&path);
    let upgraded = Database::open(&path).unwrap();
    assert_eq!(
        pending_schema(fresh.conn()),
        pending_schema(upgraded.conn())
    );
    assert_eq!(
        notifications::list_pending_completions(&upgraded, 200, 0)
            .unwrap()
            .1,
        1
    );
    // Pending attention cannot be orphaned by a standalone turn deletion.
    assert!(upgraded
        .conn()
        .execute("DELETE FROM turns WHERE id = 'unread'", [])
        .is_err());
    assert!(sessions::delete_session(&upgraded, "s").unwrap());
    assert_eq!(
        notifications::list_pending_completions(&upgraded, 200, 0)
            .unwrap()
            .1,
        0
    );
    assert!(!upgraded
        .conn()
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert!(fresh.conn().execute(
        "INSERT INTO pending_completion_notifications VALUES ('bad','missing','title','missing',1)", [],
    ).is_err());
}

#[test]
fn pending_completion_migration_failure_rolls_back_ddl_and_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v33(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("ALTER TABLE notifications DROP COLUMN session_title;")
        .unwrap();
    drop(conn);
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 33);
    assert!(!has_pending_table(&conn));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM notifications", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert!(migration_backup_path(&path, 33).exists());
}
