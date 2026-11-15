//! Host-owned elapsed checkpoints, frozen states, recovery and schema v30.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection};
use serde_json::json;

use super::model::{
    ControlAction, ModeRun, Origin, RunState, TurnOutcome, WaitReason, MAX_SAFE_INTEGER,
};
use super::repository;
use super::tests::{
    claim, configure, control_run, definition, fixture, session, settle, start_run,
};
use crate::db::{migration_backup_path, Database, SCHEMA_VERSION};

fn clock_run(db: &Database, id: &str, state: RunState) -> ModeRun {
    db.conn()
        .execute(
            "INSERT INTO sessions(id,mode,created_at,updated_at) VALUES (?1,'agent',1,1)",
            [id],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT OR IGNORE INTO mode_snapshots(hash,json,created_at) VALUES ('clock','{}','t')",
            [],
        )
        .unwrap();
    let run = ModeRun {
        id: id.into(),
        session_id: id.into(),
        mode_id: "goal".into(),
        snapshot_hash: "clock".into(),
        input: "work".into(),
        stage_id: "work".into(),
        state,
        wait_reason: (state == RunState::Waiting).then_some(WaitReason::Approval),
        last_error: None,
        revision: 1,
        active_turn_id: (state == RunState::Running).then(|| format!("{id}-turn")),
        active_origin: (state == RunState::Running).then_some(Origin::User),
        stage_entered: false,
        advanced_in_turn: false,
        pending_gate: None,
        retry_counts: BTreeMap::new(),
        rounds_completed: 0,
        tokens_used: 0,
        max_turns: Some(20),
        max_tokens: None,
        artifact_paths: BTreeMap::new(),
        settled_turns: Vec::new(),
        completion_report: None,
        elapsed_ms: 0,
        active_since_ms: (state == RunState::Running).then_some(1_000),
        created_at: 1,
        updated_at: 1_000,
        finished_at: None,
    };
    repository::insert(db.conn(), &run).unwrap();
    run
}

fn assert_clock(db: &Database, run: &ModeRun, elapsed: i64, since: Option<i64>) {
    let stored = repository::owned(db.conn(), &run.session_id, &run.id).unwrap();
    assert_eq!(stored, *run);
    assert_eq!((run.elapsed_ms, run.active_since_ms), (elapsed, since));
    let wire = run.wire();
    assert_eq!(wire["elapsedMs"], json!(elapsed));
    assert_eq!(
        wire.get("activeSinceMs"),
        since.map(|ms| json!(ms)).as_ref()
    );
}

#[test]
fn elapsed_checkpoints_round_trip_and_ignore_caller_timing_fields() {
    let fx = fixture();
    let mut run = clock_run(&fx.db, "r", RunState::Running);
    assert_clock(&fx.db, &run, 0, Some(1_000));
    let mut stale = run.clone();
    run.elapsed_ms = MAX_SAFE_INTEGER;
    run.active_since_ms = Some(0);
    repository::save_at(fx.db.conn(), &mut run, 2_000).unwrap();
    assert_clock(&fx.db, &run, 1_000, Some(2_000));
    stale.set_state(RunState::Paused);
    assert_eq!(
        repository::save_at(fx.db.conn(), &mut stale, 3_000)
            .unwrap_err()
            .to_string(),
        "MODE_REVISION_CONFLICT"
    );
    assert_clock(&fx.db, &run, 1_000, Some(2_000));
    repository::save_at(fx.db.conn(), &mut run, 2_500).unwrap();
    assert_clock(&fx.db, &run, 1_500, Some(2_500));
    run.set_state(RunState::Paused);
    repository::save_at(fx.db.conn(), &mut run, 3_000).unwrap();
    assert_clock(&fx.db, &run, 2_000, None);
    repository::save_at(fx.db.conn(), &mut run, 9_000).unwrap();
    assert_clock(&fx.db, &run, 2_000, None);
    run.clear_claim();
    run.set_state(RunState::Running);
    repository::save_at(fx.db.conn(), &mut run, 10_000).unwrap();
    assert_clock(&fx.db, &run, 2_000, Some(10_000));
    run.set_state(RunState::Stopped);
    repository::save_at(fx.db.conn(), &mut run, 10_500).unwrap();
    assert_clock(&fx.db, &run, 2_500, None);
}

#[test]
fn elapsed_freezes_in_every_non_running_state_even_with_a_claim() {
    for (state, reason) in [
        (RunState::Paused, None),
        (RunState::Waiting, Some(WaitReason::Approval)),
        (RunState::Waiting, Some(WaitReason::Retries)),
        (RunState::Waiting, Some(WaitReason::TurnEnd)),
        (RunState::Waiting, Some(WaitReason::Error)),
        (RunState::BudgetExhausted, None),
        (RunState::Finished, None),
        (RunState::Stopped, None),
    ] {
        let fx = fixture();
        let mut run = clock_run(&fx.db, "r", RunState::Running);
        run.set_state(state);
        run.wait_reason = reason;
        repository::save_at(fx.db.conn(), &mut run, 2_000).unwrap();
        assert_clock(&fx.db, &run, 1_000, None);
        repository::save_at(fx.db.conn(), &mut run, 9_000).unwrap();
        assert_clock(&fx.db, &run, 1_000, None);
        if state.is_open() {
            run.set_state(RunState::Running);
            repository::save_at(fx.db.conn(), &mut run, 10_000).unwrap();
            assert_clock(&fx.db, &run, 1_000, Some(10_000));
            repository::save_at(fx.db.conn(), &mut run, 10_500).unwrap();
            assert_clock(&fx.db, &run, 1_500, Some(10_500));
        }
    }
}

#[test]
fn elapsed_is_bounded_and_a_backwards_clock_never_recounts_an_interval() {
    let fx = fixture();
    let mut run = clock_run(&fx.db, "r", RunState::Running);
    for (now, elapsed, since) in [
        (2_000, 1_000, 2_000),
        (1_500, 1_000, 2_000),
        (2_100, 1_100, 2_100),
    ] {
        repository::save_at(fx.db.conn(), &mut run, now).unwrap();
        assert_clock(&fx.db, &run, elapsed, Some(since));
    }
    fx.db
        .conn()
        .execute(
            "UPDATE mode_runs SET elapsed_ms = ?1 WHERE id = 'r'",
            [MAX_SAFE_INTEGER - 1],
        )
        .unwrap();
    repository::save_at(fx.db.conn(), &mut run, i64::MAX).unwrap();
    assert_clock(&fx.db, &run, MAX_SAFE_INTEGER, Some(MAX_SAFE_INTEGER));
    run.set_state(RunState::Paused);
    repository::save_at(fx.db.conn(), &mut run, i64::MAX).unwrap();
    assert_clock(&fx.db, &run, MAX_SAFE_INTEGER, None);
    run.set_state(RunState::Running);
    repository::save_at(fx.db.conn(), &mut run, i64::MIN).unwrap();
    assert_clock(&fx.db, &run, MAX_SAFE_INTEGER, Some(0));
}

#[test]
fn elapsed_user_path_pause_settle_duplicate_resume_and_stop() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    let snapshot = definition(
        "clock-flow",
        "agent",
        json!([{ "id": "work", "permission": "agent", "loop": true, "exit": [] }]),
    );
    configure(&fx.db, &sid, "clock-flow", Some(&snapshot)).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    assert_clock(&fx.db, &run, 0, Some(run.created_at));
    let paused = control_run(&fx, &run, ControlAction::Pause).unwrap();
    let elapsed = paused.run.updated_at.saturating_sub(run.created_at).max(0);
    assert_clock(&fx.db, &paused.run, elapsed, None);
    let duplicate_pause = control_run(&fx, &paused.run, ControlAction::Pause).unwrap();
    assert!(!duplicate_pause.changed);
    assert_eq!(duplicate_pause.run, paused.run);
    let settled = settle(&fx, &paused.run, "t1", TurnOutcome::Completed);
    assert_clock(&fx.db, &settled.run, elapsed, None);
    let duplicate = settle(&fx, &settled.run, "t1", TurnOutcome::Completed);
    assert!(!duplicate.changed);
    assert_eq!(duplicate.run, settled.run);
    let resumed = control_run(&fx, &settled.run, ControlAction::Resume).unwrap();
    assert_clock(&fx.db, &resumed.run, elapsed, Some(resumed.run.updated_at));
    let claimed = claim(&fx, &resumed.run, "t2", Origin::Host);
    assert!(claimed.claimed);
    let stopped = control_run(&fx, &claimed.run, ControlAction::Stop).unwrap();
    let elapsed = claimed.run.elapsed_ms
        + stopped
            .run
            .updated_at
            .saturating_sub(claimed.run.active_since_ms.unwrap())
            .max(0);
    assert_clock(&fx.db, &stopped.run, elapsed, None);
    let late_settlement = settle(&fx, &stopped.run, "t2", TurnOutcome::Completed);
    assert_clock(&fx.db, &late_settlement.run, elapsed, None);
}

#[test]
fn elapsed_recovery_discards_offline_time_with_and_without_a_claim() {
    let fx = fixture();
    let path = fx.db.data_dir().join("pi.sqlite");
    let mut claimed = clock_run(&fx.db, "claimed", RunState::Running);
    repository::save_at(fx.db.conn(), &mut claimed, 2_000).unwrap();
    let mut between = clock_run(&fx.db, "between", RunState::Running);
    between.clear_claim();
    repository::save_at(fx.db.conn(), &mut between, 1_500).unwrap();
    let waiting = clock_run(&fx.db, "waiting", RunState::Waiting);
    let stopped = clock_run(&fx.db, "stopped", RunState::Stopped);
    drop(fx.db);
    let db = Database::open(&path).unwrap();
    let mut ids = repository::release_stale_claims_at(db.conn(), 9_000_000).unwrap();
    ids.sort();
    assert_eq!(ids, ["between", "claimed"]);
    for (id, elapsed) in [("claimed", 1_000), ("between", 500)] {
        let run = repository::owned(db.conn(), id, id).unwrap();
        assert_eq!(run.state, RunState::Paused);
        assert!(run.active_turn_id.is_none() && run.active_origin.is_none());
        assert_clock(&db, &run, elapsed, None);
    }
    assert_clock(&db, &waiting, 0, None);
    assert_clock(&db, &stopped, 0, None);
    assert!(repository::release_stale_claims_at(db.conn(), 10_000_000)
        .unwrap()
        .is_empty());
    let mut run = repository::owned(db.conn(), "claimed", "claimed").unwrap();
    run.set_state(RunState::Running);
    repository::save_at(db.conn(), &mut run, 10_000_000).unwrap();
    assert_clock(&db, &run, 1_000, Some(10_000_000));
    run.set_state(RunState::Paused);
    repository::save_at(db.conn(), &mut run, 10_000_500).unwrap();
    assert_clock(&db, &run, 1_500, None);
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        [table, column],
        |row| row.get(0),
    )
    .unwrap()
}

const LEGACY_STATES: [&str; 6] = [
    "running",
    "waiting",
    "paused",
    "budget_exhausted",
    "finished",
    "stopped",
];

fn populated_v29(path: &Path) {
    let db = Database::open(path).unwrap();
    db.conn()
        .execute_batch(
            "ALTER TABLE mode_runs DROP COLUMN active_since_ms;
             ALTER TABLE mode_runs DROP COLUMN elapsed_ms;
             ALTER TABLE turn_queue DROP COLUMN start_goal;
             INSERT INTO mode_snapshots(hash,json,created_at) VALUES ('legacy','{}','t');
             PRAGMA user_version = 29;",
        )
        .unwrap();
    for state in LEGACY_STATES {
        db.conn()
            .execute(
                "INSERT INTO sessions(id,mode,created_at,updated_at) VALUES (?1,'goal',1,2)",
                [state],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,
                   state,wait_reason,revision,artifact_paths,tokens_used,created_at,updated_at)
                 VALUES (?1,?1,'goal','legacy','saved objective','work',?1,?2,7,'{}',321,1,2)",
                params![state, (state == "waiting").then_some("approval")],
            )
            .unwrap();
    }
    db.conn()
        .execute_batch(
            "INSERT INTO mode_gate_results(run_id,stage_id,gate_index,action,passed,evidence,created_at)
               VALUES ('finished','work',0,'require',1,'saved evidence',2);
             INSERT INTO turn_queue(id,session_id,principal,input_hash,content,permission_mode,
               position,created_at) VALUES ('queued','running','user','hash','keep queued','ask',1,2);",
        )
        .unwrap();
}

#[test]
fn elapsed_schema_29_upgrade_preserves_populated_runs_queue_and_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v29(&path);
    let db = Database::open(&path).unwrap();
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 31);
    assert_eq!(version, SCHEMA_VERSION);
    for state in LEGACY_STATES {
        let run = repository::owned(db.conn(), state, state).unwrap();
        assert_eq!(run.state.as_str(), state);
        assert_eq!(
            (
                run.revision,
                run.tokens_used,
                run.created_at,
                run.updated_at
            ),
            (7, 321, 1, 2)
        );
        assert_eq!(run.input, "saved objective");
        assert_clock(&db, &run, 0, None);
    }
    let queued: (String, i64) = db
        .conn()
        .query_row(
            "SELECT content, start_goal FROM turn_queue WHERE id = 'queued'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(queued, ("keep queued".into(), 0));
    let evidence: String = db
        .conn()
        .query_row(
            "SELECT evidence FROM mode_gate_results WHERE run_id = 'finished'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(evidence, "saved evidence");
    let backup = Connection::open(migration_backup_path(&path, 29)).unwrap();
    let version: i64 = backup
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 29);
    assert!(!has_column(&backup, "mode_runs", "elapsed_ms"));
    assert!(!has_column(&backup, "mode_runs", "active_since_ms"));
    assert!(!has_column(&backup, "turn_queue", "start_goal"));
    let count: i64 = backup
        .query_row("SELECT COUNT(*) FROM mode_runs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 6);
    let mut legacy = repository::owned(db.conn(), "running", "running").unwrap();
    repository::save_at(db.conn(), &mut legacy, 50_000).unwrap();
    assert_clock(&db, &legacy, 0, Some(50_000));
    legacy.set_state(RunState::Paused);
    repository::save_at(db.conn(), &mut legacy, 50_500).unwrap();
    assert_clock(&db, &legacy, 500, None);
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_clock(&reopened, &legacy, 500, None);
}

#[test]
fn elapsed_schema_fresh_and_upgraded_have_identical_defaults_and_bounds() {
    let fresh = fixture();
    clock_run(&fresh.db, "fresh", RunState::Paused);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v29(&path);
    let upgraded = Database::open(&path).unwrap();
    for (table, column, expected) in [
        (
            "mode_runs",
            "elapsed_ms",
            ("INTEGER".to_string(), 1, Some("0".to_string())),
        ),
        (
            "mode_runs",
            "active_since_ms",
            ("INTEGER".to_string(), 0, None),
        ),
        (
            "turn_queue",
            "start_goal",
            ("INTEGER".to_string(), 1, Some("0".to_string())),
        ),
    ] {
        for db in [&fresh.db, &upgraded] {
            let stored: (String, i64, Option<String>) = db.conn().query_row(
                "SELECT type, \"notnull\", dflt_value FROM pragma_table_info(?1) WHERE name = ?2",
                [table, column], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(stored, expected);
        }
    }
    for db in [&fresh.db, &upgraded] {
        for invalid in [-1, MAX_SAFE_INTEGER + 1] {
            assert!(db
                .conn()
                .execute("UPDATE mode_runs SET elapsed_ms = ?1", [invalid])
                .is_err());
            assert!(db
                .conn()
                .execute("UPDATE mode_runs SET active_since_ms = ?1", [invalid])
                .is_err());
        }
    }
    upgraded
        .conn()
        .execute("UPDATE turn_queue SET start_goal = 1", [])
        .unwrap();
    assert!(upgraded
        .conn()
        .execute("UPDATE turn_queue SET start_goal = 2", [])
        .is_err());
    assert!(upgraded
        .conn()
        .execute("UPDATE turn_queue SET start_goal = NULL", [])
        .is_err());
}

#[test]
fn elapsed_schema_30_failure_rolls_back_all_additions_and_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    populated_v29(&path);
    let conn = Connection::open(&path).unwrap();
    // Force the last additive DDL to fail after both clock columns were added.
    conn.execute_batch("DROP TABLE turn_queue;").unwrap();
    drop(conn);
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 29);
    assert!(!has_column(&conn, "mode_runs", "elapsed_ms"));
    assert!(!has_column(&conn, "mode_runs", "active_since_ms"));
    assert!(migration_backup_path(&path, 29).is_file());
}
