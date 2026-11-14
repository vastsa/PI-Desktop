//! Schema 31 is additive: legacy runs, gate evidence, snapshots and queues survive.

use super::*;

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

fn has_report(conn: &Connection) -> bool {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('mode_runs') WHERE name='completion_report_json')", [], |row| row.get(0)).unwrap()
}

fn rows(conn: &Connection, sql: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut statement = conn.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn populated_v30(path: &Path, preexisting_report: bool) {
    let db = Database::open(path).unwrap();
    // Recreate the exact original CHECK even when this helper runs on v31.
    db.conn()
        .execute_batch(
            "DROP TABLE mode_gate_results; DROP TABLE mode_runs; DROP TABLE mode_snapshots;",
        )
        .unwrap();
    db.conn().execute_batch(MODE_RUNS_SCHEMA).unwrap();
    let tx = db.conn().unchecked_transaction().unwrap();
    super::mode_run_elapsed_migration::initialize(&tx).unwrap();
    tx.execute_batch("INSERT INTO sessions(id,title,mode,created_at,updated_at) VALUES ('s','legacy goal','goal',1,2);
        INSERT INTO mode_snapshots(hash,json,created_at) VALUES ('legacy','{\"version\":1}','t');
        INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,state,wait_reason,last_error,
            active_turn_id,active_origin,pending_gate,retry_counts,rounds_completed,tokens_used,max_turns,max_tokens,
            artifact_paths,settled_turns,created_at,updated_at,elapsed_ms,active_since_ms)
        VALUES ('r','s','goal','legacy','objective','work','waiting','error','old error','t','host',2,'{\"work:0\":1}',3,400,20,10000,'{\"goal\":\".pi/goal.md\"}','[\"previous\"]',1,2,1234,NULL);
        INSERT INTO mode_gate_results(id,run_id,stage_id,gate_index,action,passed,evidence,tool_call_id,created_at)
        VALUES (7,'r','work',0,'run',1,'kept evidence','call',2);
        INSERT INTO turn_queue(id,session_id,principal,input_hash,content,permission_mode,position,created_at,start_goal)
        VALUES ('queued','s','desktop','hash','next','auto',1,2,1);
        INSERT INTO turns(id,session_id,status,started_at,ended_at) VALUES ('old-turn','s','completed',1,2);
        PRAGMA user_version=30;").unwrap();
    if preexisting_report {
        tx.execute_batch(
            "ALTER TABLE mode_runs ADD COLUMN completion_report_json TEXT;
            UPDATE mode_runs SET completion_report_json='{\"legacyEvidence\":true}';",
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

const LEGACY_RUN: &str = "SELECT id,session_id,mode_id,snapshot_hash,input,stage_id,state,wait_reason,last_error,
    revision,active_turn_id,active_origin,stage_entered,advanced_in_turn,pending_gate,retry_counts,
    rounds_completed,tokens_used,max_turns,max_tokens,artifact_paths,settled_turns,created_at,updated_at,
    finished_at,elapsed_ms,active_since_ms FROM mode_runs";

#[test]
fn completion_report_migration_populated_30_preserves_all_data_and_pre_migration_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v30(&path, false);
    let before = Connection::open(&path).unwrap();
    let old_run = rows(&before, LEGACY_RUN);
    let gates = rows(&before, "SELECT * FROM mode_gate_results");
    let snapshots = rows(&before, "SELECT * FROM mode_snapshots");
    let sessions = rows(&before, "SELECT * FROM sessions");
    let queue = rows(&before, "SELECT * FROM turn_queue");
    let turns = rows(&before, "SELECT * FROM turns");
    drop(before);
    let db = Database::open(&path).unwrap();
    assert_eq!(version(db.conn()), 31);
    assert_eq!(SCHEMA_VERSION, 31);
    assert!(has_report(db.conn()));
    assert_eq!(rows(db.conn(), LEGACY_RUN), old_run);
    assert_eq!(rows(db.conn(), "SELECT * FROM mode_gate_results"), gates);
    assert_eq!(rows(db.conn(), "SELECT * FROM mode_snapshots"), snapshots);
    assert_eq!(rows(db.conn(), "SELECT * FROM sessions"), sessions);
    assert_eq!(rows(db.conn(), "SELECT * FROM turn_queue"), queue);
    assert_eq!(rows(db.conn(), "SELECT * FROM turns"), turns);
    assert_eq!(
        rows(db.conn(), "SELECT completion_report_json FROM mode_runs"),
        vec![vec![rusqlite::types::Value::Null]]
    );
    assert!(rows(db.conn(), "PRAGMA foreign_key_check").is_empty());
    let backup = Connection::open(migration_backup_path(&path, 30)).unwrap();
    assert_eq!(version(&backup), 30);
    assert!(!has_report(&backup));
    assert_eq!(rows(&backup, LEGACY_RUN), old_run);
    assert_eq!(rows(&backup, "SELECT * FROM mode_gate_results"), gates);
    assert_eq!(rows(&backup, "SELECT * FROM turn_queue"), queue);
    // The old CHECK still rejects blocked; the upgraded one permits it only while waiting.
    assert!(backup
        .execute("UPDATE mode_runs SET wait_reason='blocked'", [])
        .is_err());
    db.conn()
        .execute("UPDATE mode_runs SET wait_reason='blocked'", [])
        .unwrap();
    assert!(db
        .conn()
        .execute("UPDATE mode_runs SET state='running'", [])
        .is_err());
    assert!(db
        .conn()
        .execute("UPDATE mode_runs SET wait_reason='unknown'", [])
        .is_err());
    db.conn()
        .execute("DELETE FROM sessions WHERE id='s'", [])
        .unwrap();
    assert!(rows(db.conn(), "SELECT * FROM mode_runs").is_empty());
    assert!(rows(db.conn(), "SELECT * FROM mode_gate_results").is_empty());
}

#[test]
fn completion_report_migration_is_idempotent_with_a_preexisting_column() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v30(&path, true);
    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), 31);
        assert_eq!(
            rows(db.conn(), "SELECT completion_report_json FROM mode_runs"),
            vec![vec![rusqlite::types::Value::Text(
                "{\"legacyEvidence\":true}".into()
            )]]
        );
        assert_eq!(
            rows(db.conn(), "SELECT id FROM mode_gate_results"),
            vec![vec![rusqlite::types::Value::Integer(7)]]
        );
    }
    let backup = Connection::open(migration_backup_path(&path, 30)).unwrap();
    assert_eq!(version(&backup), 30);
    assert!(has_report(&backup));
}

fn schema(conn: &Connection) -> Vec<Vec<rusqlite::types::Value>> {
    rows(conn, "SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('mode_runs','mode_gate_results') ORDER BY type,name")
}

#[test]
fn completion_report_migration_fresh_and_older_chain_have_identical_schema_31() {
    let dir = tempfile::tempdir().unwrap();
    let fresh = Database::open(&dir.path().join("fresh.sqlite")).unwrap();
    assert_eq!(version(fresh.conn()), 31);
    assert!(has_report(fresh.conn()));
    let path = dir.path().join("older.sqlite");
    populated_v30(&path, false);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "ALTER TABLE mode_runs DROP COLUMN active_since_ms;
        ALTER TABLE mode_runs DROP COLUMN elapsed_ms;
        ALTER TABLE turn_queue DROP COLUMN start_goal;
        PRAGMA user_version=29;",
    )
    .unwrap();
    drop(conn);
    let upgraded = Database::open(&path).unwrap();
    assert_eq!(version(upgraded.conn()), 31);
    assert_eq!(schema(upgraded.conn()), schema(fresh.conn()));
    for v in [29, 30] {
        let backup = Connection::open(migration_backup_path(&path, v)).unwrap();
        assert_eq!(version(&backup), v);
        assert!(!has_report(&backup));
    }
}

#[test]
fn completion_report_migration_failure_rolls_back_schema_rows_and_restores_foreign_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v30(&path, false);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=OFF;
        INSERT INTO mode_gate_results(run_id,stage_id,gate_index,action,passed,created_at)
        VALUES ('missing','work',0,'run',0,2);
        PRAGMA foreign_keys=ON;",
    )
    .unwrap();
    let before = rows(&conn, LEGACY_RUN);
    let gates = rows(&conn, "SELECT * FROM mode_gate_results ORDER BY id");
    let before_schema = schema(&conn);
    assert!(super::completion_report_migration::migrate(&conn, &path).is_err());
    assert_eq!(version(&conn), 30);
    assert!(!has_report(&conn));
    assert_eq!(schema(&conn), before_schema);
    assert_eq!(rows(&conn, LEGACY_RUN), before);
    assert_eq!(
        rows(&conn, "SELECT * FROM mode_gate_results ORDER BY id"),
        gates
    );
    let foreign_keys: bool = conn
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .unwrap();
    assert!(foreign_keys);
    assert!(rows(
        &conn,
        "SELECT name FROM sqlite_master WHERE name='mode_runs_v31'"
    )
    .is_empty());
    let backup = Connection::open(migration_backup_path(&path, 30)).unwrap();
    assert_eq!(version(&backup), 30);
    assert!(!has_report(&backup));
}
