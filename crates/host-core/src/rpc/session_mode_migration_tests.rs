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
