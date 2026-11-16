use super::*;
use crate::db::migration_backup_path;
use std::path::PathBuf;

fn fixture(check: &str) -> (tempfile::TempDir, Connection, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE \"sessions\" (
           id TEXT PRIMARY KEY,
           mode TEXT NOT NULL DEFAULT 'agent' {check},
           payload BLOB NOT NULL,
           permission_mode TEXT NOT NULL CHECK (permission_mode IN ('ask','auto')),
           sequence INTEGER NOT NULL CHECK (sequence >= 0)
         );
         CREATE TABLE children (
           id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
         );
         CREATE TABLE mode_audit(old_mode TEXT, new_mode TEXT);
         CREATE INDEX saved_payload ON sessions(payload) WHERE sequence > 0;
         CREATE TRIGGER saved_mode_trigger AFTER UPDATE OF mode ON sessions
           BEGIN INSERT INTO mode_audit VALUES(old.mode,new.mode); END;
         CREATE TRIGGER child_session_lookup AFTER INSERT ON children
           BEGIN SELECT mode FROM sessions WHERE id=new.session_id; END;
         CREATE VIEW saved_sessions AS SELECT id,mode,sequence FROM sessions;
         INSERT INTO sessions VALUES('saved','goal',X'0001FEFF','auto',17);
         INSERT INTO children VALUES('child','saved');
         PRAGMA user_version=31;"
    ))
    .unwrap();
    (dir, conn, path)
}

fn version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn schema(conn: &Connection) -> String {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE name='sessions'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn objects(conn: &Connection) -> Vec<(String, String)> {
    conn.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY name")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn session_mode_migration_preserves_rows_children_and_schema_objects() {
    for check in [
        "CHECK (mode IN ('agent','plan','goal'))",
        "check (\n\"mode\" in ( 'agent' , 'plan' , 'goal' )\n)",
    ] {
        let (_dir, conn, path) = fixture(check);
        let before_schema = schema(&conn);
        let before_objects = objects(&conn);
        migrate(&conn, &path).unwrap();
        assert_eq!(version(&conn), 32);
        let row: (String, String, Vec<u8>, String, i64) = conn
            .query_row("SELECT * FROM sessions", [], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap();
        assert_eq!(
            row,
            (
                "saved".into(),
                "goal".into(),
                vec![0, 1, 254, 255],
                "auto".into(),
                17
            )
        );
        assert_eq!(objects(&conn), before_objects);
        assert!(!conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        let backup = Connection::open(migration_backup_path(&path, 31)).unwrap();
        assert_eq!(version(&backup), 31);
        assert_eq!(schema(&backup), before_schema);
        assert_eq!(objects(&backup), before_objects);

        conn.execute("UPDATE sessions SET mode='review' WHERE id='saved'", [])
            .unwrap();
        let mode: String = conn
            .query_row("SELECT mode FROM saved_sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "review");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM mode_audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert!(conn
            .execute("UPDATE sessions SET permission_mode='unsafe'", [])
            .is_err());
        assert!(conn.execute("UPDATE sessions SET mode=NULL", []).is_err());
        assert!(conn.execute("UPDATE sessions SET sequence=-1", []).is_err());
        assert!(conn
            .pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))
            .unwrap());
        assert!(!conn
            .pragma_query_value(None, "legacy_alter_table", |row| row.get::<_, bool>(0))
            .unwrap());
        let children: i64 = conn
            .query_row("SELECT count(*) FROM children", [], |row| row.get(0))
            .unwrap();
        assert_eq!(children, 1);
        conn.execute("DELETE FROM sessions WHERE id='saved'", [])
            .unwrap();
        let children: i64 = conn
            .query_row("SELECT count(*) FROM children", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            children, 0,
            "child cascade must remain enabled after migration"
        );
    }
}

#[test]
fn session_mode_migration_does_not_rebuild_unconstrained_databases() {
    let (_dir, conn, path) = fixture("");
    conn.execute("UPDATE sessions SET mode='review'", [])
        .unwrap();
    let before = schema(&conn);
    let before_objects = objects(&conn);
    migrate(&conn, &path).unwrap();
    assert_eq!(version(&conn), 32);
    assert_eq!(schema(&conn), before);
    assert_eq!(objects(&conn), before_objects);
    let mode: String = conn
        .query_row("SELECT mode FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "review");
}

#[test]
fn session_mode_migration_rolls_back_and_restores_pragmas_on_rebuild_failure() {
    for foreign_keys in [false, true] {
        for legacy_alter_table in [false, true] {
            let (_dir, conn, path) = fixture("CHECK (mode IN ('agent','plan','goal'))");
            conn.execute_batch("CREATE TABLE sessions_v32(unrelated TEXT);")
                .unwrap();
            conn.pragma_update(None, "foreign_keys", foreign_keys)
                .unwrap();
            conn.pragma_update(None, "legacy_alter_table", legacy_alter_table)
                .unwrap();
            let before = schema(&conn);
            let before_objects = objects(&conn);
            assert!(migrate(&conn, &path).is_err());
            assert_eq!(version(&conn), 31);
            assert_eq!(schema(&conn), before);
            assert_eq!(objects(&conn), before_objects);
            assert_eq!(
                conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))
                    .unwrap(),
                foreign_keys
            );
            assert_eq!(
                conn.pragma_query_value(None, "legacy_alter_table", |row| row.get::<_, bool>(0))
                    .unwrap(),
                legacy_alter_table
            );
            assert!(migration_backup_path(&path, 31).is_file());
        }
    }
}

#[test]
fn session_mode_migration_foreign_key_failure_rolls_back_the_replacement() {
    let (_dir, conn, path) = fixture("CHECK (mode IN ('agent','plan','goal'))");
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    conn.execute("INSERT INTO children VALUES('orphan','missing')", [])
        .unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let before = schema(&conn);
    let before_objects = objects(&conn);
    let error = migrate(&conn, &path).unwrap_err();
    assert!(error.to_string().contains("foreign key check failed"));
    assert_eq!(version(&conn), 31);
    assert_eq!(schema(&conn), before);
    assert_eq!(objects(&conn), before_objects);
    assert!(conn
        .execute("UPDATE sessions SET mode='review'", [])
        .is_err());
    assert!(conn
        .pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))
        .unwrap());
    assert!(!conn
        .pragma_query_value(None, "legacy_alter_table", |row| row.get::<_, bool>(0))
        .unwrap());
    let temporary: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='sessions_v32')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!temporary);
    let count: i64 = conn
        .query_row("SELECT count(*) FROM children", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
}
