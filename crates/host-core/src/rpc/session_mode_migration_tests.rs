use super::*;
use crate::db::{Connection, Database, MODE_RUNS_SCHEMA};

const LEGACY_MODE_CHECK: &str = "CHECK (mode IN ('agent','plan','goal'))";

/// Reintroduce the persisted legacy constraint instead of merely lowering the
/// version of a fresh, already-unconstrained sessions table.
fn legacy_database(path: &Path, version: i64, check: &str) {
    let db = Database::open(path).unwrap();
    let conn = db.conn();
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let column = "mode        TEXT NOT NULL DEFAULT 'agent'";
    assert_eq!(sql.matches(column).count(), 1);
    let constrained = sql.replace(column, &format!("{column} {check}")).replacen(
        "CREATE TABLE sessions",
        "CREATE TABLE sessions_legacy",
        1,
    );
    let objects = conn
        .prepare("SELECT sql FROM sqlite_master WHERE tbl_name='sessions' AND type IN ('index','trigger') AND sql IS NOT NULL")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    conn.execute_batch(&constrained).unwrap();
    conn.execute_batch(
        "INSERT INTO sessions_legacy SELECT * FROM sessions;
         DROP TABLE sessions;
         ALTER TABLE sessions_legacy RENAME TO sessions;",
    )
    .unwrap();
    for object in objects {
        conn.execute_batch(&object).unwrap();
    }
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    if version < 31 {
        conn.execute_batch(
            "DROP TABLE mode_gate_results;
             DROP TABLE mode_runs;
             DROP TABLE mode_snapshots;",
        )
        .unwrap();
        if version == 28 {
            conn.execute_batch("ALTER TABLE sessions DROP COLUMN mode_snapshot_hash;")
                .unwrap();
        } else {
            conn.execute_batch(MODE_RUNS_SCHEMA).unwrap();
            if version == 30 {
                conn.execute_batch(
                    "ALTER TABLE mode_runs ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0
                       CHECK (elapsed_ms BETWEEN 0 AND 9007199254740991);
                     ALTER TABLE mode_runs ADD COLUMN active_since_ms INTEGER
                       CHECK (active_since_ms BETWEEN 0 AND 9007199254740991);",
                )
                .unwrap();
            }
        }
        if version <= 29 {
            conn.execute_batch("ALTER TABLE turn_queue DROP COLUMN start_goal;")
                .unwrap();
        }
    }
    conn.pragma_update(None, "user_version", version).unwrap();
}

fn definition(mode: &str) -> Value {
    serde_json::json!({ "version": 1, "id": mode, "permission": "contract", "stages": [] })
}

#[tokio::test]
async fn custom_mode_selection_on_legacy_database_works_through_session_rpc() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    legacy_database(&path, 31, LEGACY_MODE_CHECK);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO sessions(id,title,mode,created_at,updated_at)
         VALUES('existing','Saved task','agent',1,1);",
    )
    .unwrap();
    let error = conn
        .execute("UPDATE sessions SET mode='review' WHERE id='existing'", [])
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("mode IN ('agent','plan','goal')"));
    drop(conn);

    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let selected = handle_request(
        state.clone(),
        "session.configure",
        serde_json::json!({ "id": "existing", "mode": "review", "modeSnapshot": definition("review") }),
        tx.clone(),
    )
    .await
    .expect("upgrading a legacy database must allow selecting a validated custom mode");
    assert_eq!(selected["session"]["mode"], "review");

    let created = handle_request(
        state.clone(),
        "session.create",
        serde_json::json!({ "mode": "brainstorm", "modeSnapshot": definition("brainstorm") }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(created["session"]["mode"], "brainstorm");

    for mode in ["agent", "plan", "goal", "review"] {
        let mut params = serde_json::json!({ "id": "existing", "mode": mode });
        if mode == "review" {
            params["modeSnapshot"] = definition(mode);
        }
        let configured = handle_request(state.clone(), "session.configure", params, tx.clone())
            .await
            .unwrap();
        assert_eq!(configured["session"]["mode"], mode);
    }
    let error = handle_request(
        state.clone(),
        "session.configure",
        serde_json::json!({ "id": "existing", "mode": "review", "modeSnapshot": definition("other") }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "MODE_SNAPSHOT_INVALID");
    {
        let app = state.lock().await;
        assert_eq!(
            crate::mode_runs::tool_policy(&app.db, "existing").unwrap(),
            Some(crate::mode_runs::ToolPolicy::Contract)
        );
    }
    drop(state);
    let db = Database::open(&path).unwrap();
    let (mode, snapshot): (String, Option<String>) = db
        .conn()
        .query_row(
            "SELECT mode,mode_snapshot_hash FROM sessions WHERE id='existing'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(mode, "review");
    assert!(snapshot.is_some());
}

#[tokio::test]
async fn custom_mode_selection_upgrades_older_mode_schemas() {
    for version in [28, 29, 30] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        legacy_database(&path, version, LEGACY_MODE_CHECK);
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        let created = handle_request(
            state.clone(),
            "session.create",
            json!({ "mode": "review", "modeSnapshot": definition("review") }),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(created["session"]["mode"], "review", "schema {version}");
        let app = state.lock().await;
        let migrated: i64 = app
            .db
            .conn()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(migrated, crate::db::SCHEMA_VERSION);
    }
}

const LEGACY_GOAL_EXECUTION_SCHEMA: &str = r#"
CREATE TABLE session_goals(id TEXT PRIMARY KEY, payload BLOB NOT NULL);
CREATE TABLE goal_turns (
  turn_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES session_goals(id) ON DELETE CASCADE,
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
  interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1)),
  tokens INTEGER CHECK(tokens >= 0)
);
CREATE TABLE turn_execution (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('agent','plan','goal')),
  goal_claim_id TEXT UNIQUE REFERENCES goal_turns(turn_id),
  provenance TEXT CHECK(provenance IN ('user-goal','goal-continuation')),
  CHECK((goal_claim_id IS NULL AND provenance IS NULL) OR
        (goal_claim_id IS NOT NULL AND provenance IS NOT NULL AND mode='goal'))
);
CREATE INDEX legacy_execution_mode ON turn_execution(mode);
CREATE TRIGGER turn_execution_snapshot AFTER INSERT ON turns
BEGIN
  INSERT INTO turn_execution(turn_id,mode)
  SELECT NEW.id,mode FROM sessions WHERE id=NEW.session_id;
END;
CREATE TABLE retained_turn_audit(turn_id TEXT NOT NULL);
CREATE TRIGGER retained_turn_audit AFTER INSERT ON turns
BEGIN
  INSERT INTO retained_turn_audit VALUES(NEW.id);
END;
INSERT INTO sessions(id,title,mode,created_at,updated_at)
VALUES('existing','Saved task','agent',1,1);
INSERT INTO session_goals VALUES('saved-goal',X'00FE');
INSERT INTO goal_turns VALUES('saved-claim','saved-goal',1,0,17);
INSERT INTO turns(id,session_id,status,started_at,ended_at)
VALUES('saved-turn','existing','completed',1,2);
UPDATE turn_execution SET mode='goal',goal_claim_id='saved-claim',
  provenance='goal-continuation' WHERE turn_id='saved-turn';
"#;

fn legacy_goal_database(path: &Path, version: i64, check: &str) {
    legacy_database(path, version, check);
    Connection::open(path)
        .unwrap()
        .execute_batch(LEGACY_GOAL_EXECUTION_SCHEMA)
        .unwrap();
}

fn legacy_goal_snapshot(conn: &Connection) -> (String, String, String, Vec<u8>, i64) {
    conn.query_row(
        "SELECT e.mode,e.goal_claim_id,e.provenance,g.payload,c.tokens
         FROM turn_execution e JOIN goal_turns c ON c.turn_id=e.goal_claim_id
         JOIN session_goals g ON g.id=c.goal_id WHERE e.turn_id='saved-turn'",
        [],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .unwrap()
}

fn has_legacy_goal_trigger(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master
         WHERE type='trigger' AND name='turn_execution_snapshot')",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn legacy_goal_schema_allows_custom_mode_turns_without_losing_history() {
    for (version, check) in [(31, LEGACY_MODE_CHECK), (32, ""), (32, LEGACY_MODE_CHECK)] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        legacy_goal_database(&path, version, check);
        let before = legacy_goal_snapshot(&Connection::open(&path).unwrap());
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        let selected = handle_request(
            state.clone(),
            "session.configure",
            json!({"id":"existing","mode":"goal-3","modeSnapshot":definition("goal-3")}),
            tx.clone(),
        )
        .await
        .expect("legacy schema 32 must allow custom mode selection too");
        assert_eq!(selected["session"]["mode"], "goal-3");
        let turn = handle_request(
            state.clone(),
            "session.beginTurn",
            json!({"sessionId":"existing"}),
            tx.clone(),
        )
        .await
        .expect("retired Goal triggers must not reject a custom-mode turn");
        let ended = handle_request(
            state.clone(),
            "session.endTurn",
            json!({"turnId":turn["turnId"],"status":"completed","createNotification":false}),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(ended["ok"], true);
        {
            let app = state.lock().await;
            assert_eq!(legacy_goal_snapshot(app.db.conn()), before);
            assert!(!has_legacy_goal_trigger(app.db.conn()));
            let audit: i64 = app
                .db
                .conn()
                .query_row("SELECT count(*) FROM retained_turn_audit", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(audit, 2, "unrelated triggers must still run");
            let rows: i64 = app
                .db
                .conn()
                .query_row("SELECT count(*) FROM turn_execution", [], |row| row.get(0))
                .unwrap();
            assert_eq!(
                rows, 1,
                "the legacy ledger is retained but no longer populated"
            );
        }
        drop(state);
        let backup_path = dir.path().join("pi.sqlite.v32.bak");
        let backup = Connection::open(&backup_path).unwrap();
        assert!(has_legacy_goal_trigger(&backup));
        assert_eq!(legacy_goal_snapshot(&backup), before);
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            32
        );
        drop(backup);
        let backup_bytes = std::fs::read(&backup_path).unwrap();
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            reopened
                .conn()
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            crate::db::SCHEMA_VERSION
        );
        assert_eq!(legacy_goal_snapshot(reopened.conn()), before);
        assert!(!has_legacy_goal_trigger(reopened.conn()));
        assert_eq!(std::fs::read(&backup_path).unwrap(), backup_bytes);
        assert!(!reopened
            .conn()
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }
}

#[test]
fn legacy_goal_migration_rolls_back_trigger_retirement_on_rebuild_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    legacy_goal_database(&path, 32, LEGACY_MODE_CHECK);
    let conn = Connection::open(&path).unwrap();
    let before = legacy_goal_snapshot(&conn);
    conn.execute_batch("CREATE TABLE sessions_v32(unrelated TEXT);")
        .unwrap();
    drop(conn);
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        32
    );
    assert!(has_legacy_goal_trigger(&conn));
    assert_eq!(legacy_goal_snapshot(&conn), before);
    assert!(conn
        .execute("UPDATE sessions SET mode='goal-3'", [])
        .is_err());
    assert!(dir.path().join("pi.sqlite.v32.bak").is_file());
}

#[test]
fn legacy_goal_migration_refuses_changes_without_a_valid_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    legacy_goal_database(&path, 32, "");
    std::fs::create_dir(dir.path().join("pi.sqlite.v32.bak")).unwrap();
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        32
    );
    assert!(has_legacy_goal_trigger(&conn));
    assert_eq!(legacy_goal_snapshot(&conn).3, vec![0, 254]);
}

#[test]
fn legacy_goal_migration_preserves_an_already_unconstrained_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let before: String = db
        .conn()
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.conn()
        .pragma_update(None, "user_version", 32i64)
        .unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let after: String = db
        .conn()
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        db.conn()
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        crate::db::SCHEMA_VERSION
    );
}

#[test]
fn legacy_goal_migration_rolls_back_on_foreign_key_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    legacy_goal_database(&path, 32, "");
    let conn = Connection::open(&path).unwrap();
    let before = legacy_goal_snapshot(&conn);
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    conn.execute(
        "INSERT INTO goal_turns(turn_id,goal_id) VALUES('orphan','missing')",
        [],
    )
    .unwrap();
    drop(conn);
    let error = Database::open(&path)
        .err()
        .expect("broken references must prevent migration commit");
    assert!(error.to_string().contains("foreign key check failed"));
    let conn = Connection::open(&path).unwrap();
    assert!(has_legacy_goal_trigger(&conn));
    assert_eq!(legacy_goal_snapshot(&conn), before);
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        32
    );
    assert!(dir.path().join("pi.sqlite.v32.bak").is_file());
}
