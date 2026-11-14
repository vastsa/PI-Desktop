use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Staged mode storage (ADR mode-definitions). One batch so a fresh database
/// and the v28 -> v29 migration cannot drift in tables, checks or indexes.
///
/// - `mode_snapshots` keeps every definition a session or run used, keyed by
///   the SHA-256 of its JSON. Rows are immutable: editing a mode never changes
///   a running run.
/// - `mode_runs` is the run state machine. The partial unique index allows at
///   most one open run per session.
/// - `mode_gate_results` records every gate the Host evaluated.
pub(crate) const MODE_RUNS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS mode_snapshots (
  hash       TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mode_runs (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mode_id          TEXT NOT NULL,
  snapshot_hash    TEXT NOT NULL REFERENCES mode_snapshots(hash),
  input            TEXT NOT NULL,
  stage_id         TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN (
    'running', 'waiting', 'paused', 'budget_exhausted', 'finished', 'stopped'
  )),
  wait_reason      TEXT CHECK (wait_reason IN ('approval', 'retries', 'turn_end', 'error')),
  last_error       TEXT,
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_turn_id   TEXT,
  active_origin    TEXT CHECK (active_origin IN ('user', 'approval', 'host')),
  stage_entered    INTEGER NOT NULL DEFAULT 1 CHECK (stage_entered IN (0, 1)),
  advanced_in_turn INTEGER NOT NULL DEFAULT 0 CHECK (advanced_in_turn IN (0, 1)),
  pending_gate     INTEGER,
  retry_counts     TEXT NOT NULL DEFAULT '{}',
  rounds_completed INTEGER NOT NULL DEFAULT 0 CHECK (rounds_completed >= 0),
  tokens_used      INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  max_turns        INTEGER,
  max_tokens       INTEGER,
  artifact_paths   TEXT NOT NULL,
  settled_turns    TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  CHECK ((state = 'waiting') = (wait_reason IS NOT NULL)),
  CHECK ((active_turn_id IS NULL) = (active_origin IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mode_runs_one_open
  ON mode_runs(session_id)
  WHERE state IN ('running', 'waiting', 'paused', 'budget_exhausted');
CREATE INDEX IF NOT EXISTS idx_mode_runs_session
  ON mode_runs(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mode_gate_results (
  id           INTEGER PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES mode_runs(id) ON DELETE CASCADE,
  stage_id     TEXT NOT NULL,
  gate_index   INTEGER NOT NULL CHECK (gate_index >= 0),
  action       TEXT NOT NULL CHECK (action IN ('require', 'run', 'ask')),
  passed       INTEGER CHECK (passed IN (0, 1)),
  evidence     TEXT CHECK (evidence IS NULL OR length(evidence) <= 8192),
  tool_call_id TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mode_gate_results_run
  ON mode_gate_results(run_id, id);
"#;

/// v29 adds staged mode runs. Existing sessions keep their mode and get no
/// snapshot, so builtin `agent` / `plan` / `goal` keep today's tool policy.
fn migrate_v28_to_v29_tx(tx: &Transaction<'_>) -> Result<()> {
    let has_snapshot_hash: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions')
                       WHERE name = 'mode_snapshot_hash')",
        [],
        |row| row.get(0),
    )?;
    if !has_snapshot_hash {
        tx.execute_batch("ALTER TABLE sessions ADD COLUMN mode_snapshot_hash TEXT;")?;
    }
    tx.execute_batch(MODE_RUNS_SCHEMA)?;
    tx.pragma_update(None, "user_version", 29i64)?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 28)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v28_to_v29_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v28 to v29 mode runs migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::*;

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn has_table(conn: &Connection, table: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Build a genuine v28 file: the v29 objects are removed again, so the
    /// upgrade has to create every one of them.
    fn v28_database(path: &Path) {
        let db = Database::open(path).unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO sessions(id,title,mode,created_at,updated_at)
                   VALUES ('plan-session','Saved plan','plan',1,1),
                          ('goal-session','Saved goal','goal',1,1);
                 INSERT INTO turns(id,session_id,status,started_at,ended_at)
                   VALUES ('saved-turn','plan-session','completed',1,2);
                 DROP TABLE mode_gate_results;
                 DROP TABLE mode_runs;
                 DROP TABLE mode_snapshots;
                 ALTER TABLE sessions DROP COLUMN mode_snapshot_hash;
                 PRAGMA user_version=28;",
            )
            .unwrap();
    }

    #[test]
    fn schema_28_upgrades_with_data_preserved_and_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        v28_database(&path);
        assert!(!has_column(
            &Connection::open(&path).unwrap(),
            "sessions",
            "mode_snapshot_hash"
        ));

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(SCHEMA_VERSION, 31);
        assert!(has_column(db.conn(), "sessions", "mode_snapshot_hash"));
        for table in ["mode_snapshots", "mode_runs", "mode_gate_results"] {
            assert!(has_table(db.conn(), table), "{table}");
        }
        let modes: Vec<(String, String, Option<String>)> = db
            .conn()
            .prepare("SELECT id, mode, mode_snapshot_hash FROM sessions ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            modes,
            vec![
                ("goal-session".into(), "goal".into(), None),
                ("plan-session".into(), "plan".into(), None)
            ]
        );
        let turns: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM turns", [], |row| row.get(0))
            .unwrap();
        assert_eq!(turns, 1);
        let backup = Connection::open(migration_backup_path(&path, 28)).unwrap();
        assert_eq!(version(&backup), 28);
        assert!(!has_table(&backup, "mode_runs"));
    }

    #[test]
    fn fresh_database_has_mode_tables_and_one_open_run_per_session() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_column(db.conn(), "sessions", "mode_snapshot_hash"));
        db.conn()
            .execute_batch(
                "INSERT INTO sessions(id,created_at,updated_at) VALUES ('s',1,1);
                 INSERT INTO mode_snapshots(hash,json,created_at) VALUES ('h','{}','t');
                 INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,
                   state,artifact_paths,created_at,updated_at)
                   VALUES ('r1','s','review','h','go','draft','paused','{}',1,1);",
            )
            .unwrap();
        let second = db.conn().execute(
            "INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,
               state,artifact_paths,created_at,updated_at)
               VALUES ('r2','s','review','h','go','draft','running','{}',1,1)",
            [],
        );
        assert!(second.is_err(), "a second open run must be refused");
        db.conn()
            .execute_batch(
                "UPDATE mode_runs SET state='finished' WHERE id='r1';
                 INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,
                   state,artifact_paths,created_at,updated_at)
                   VALUES ('r2','s','review','h','go','draft','running','{}',1,1);",
            )
            .unwrap();
        // A waiting run must say why; any other state must not.
        assert!(db
            .conn()
            .execute("UPDATE mode_runs SET state='waiting' WHERE id='r2'", [])
            .is_err());
        // Deleting the session removes its runs.
        db.conn()
            .execute("DELETE FROM sessions WHERE id='s'", [])
            .unwrap();
        let runs: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM mode_runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(runs, 0);
    }

    #[test]
    fn future_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        db.conn()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(db);
        let error = Database::open(&path)
            .err()
            .expect("future schema must be refused");
        assert!(error.to_string().contains("is newer than supported"));
    }

    #[test]
    fn schema_27_chains_through_the_project_path_step_into_29() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        v28_database(&path);
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 27)
            .unwrap();
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_table(db.conn(), "mode_runs"));
        for schema in [27, 28] {
            let backup = Connection::open(migration_backup_path(&path, schema)).unwrap();
            assert_eq!(version(&backup), schema);
        }
    }

    #[test]
    fn failed_version_stamp_keeps_schema_28() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        v28_database(&path);
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "query_only", true).unwrap();
        assert!(super::migrate(&conn, &path).is_err());
        assert_eq!(version(&conn), 28);
        assert!(!has_table(&conn, "mode_runs"));
        conn.pragma_update(None, "query_only", false).unwrap();
        super::migrate(&conn, &path).unwrap();
        assert_eq!(version(&conn), 29);
        assert!(has_table(&conn, "mode_runs"));
    }
}
