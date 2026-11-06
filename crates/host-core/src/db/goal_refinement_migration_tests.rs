use super::*;
use crate::{
    db::{migration_backup_path, Database, SCHEMA_VERSION},
    goals, sessions,
};
use serde_json::{json, Value};

fn v30_fixture(path: &Path, status: &str) -> (String, goals::SessionGoal, Value) {
    let db = Database::open(path).unwrap();
    let session =
        sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
    db.set_setting("app", &json!({"theme":"light"})).unwrap();
    let g = goals::start(
        &db,
        serde_json::from_value(json!({"sessionId":session.id,
        "objective":"  exact legacy scope  ","budget":{"maxTurns":7,"maxTokens":99}}))
        .unwrap(),
    )
    .unwrap();
    let (g, claimed) = goals::claim_turn(
        &db,
        serde_json::from_value(json!({"sessionId":session.id,
        "goalId":g.id,"expectedRevision":g.revision,"turnId":"v30-claim"}))
        .unwrap(),
    )
    .unwrap();
    assert!(claimed);
    let g = goals::report(
        &db,
        serde_json::from_value(json!({"sessionId":session.id,"goalId":g.id,
        "turnId":"v30-claim","progressSummary":"legacy progress","status":"active",
        "outcomes":[{"criterion":g.objective,"outcome":"unmet","evidence":"legacy evidence"}],
        "audit":{"version":1,"objective":g.objective,"remainingWork":["finish"],
        "items":[{"requirement":"legacy scope","outcome":"unmet","evidence":"legacy evidence"}]}}))
        .unwrap(),
    )
    .unwrap();
    db.conn().execute("UPDATE session_goals SET status=?1,token_usage=11,elapsed_ms=1234,active_since_ms=5000,deleted=?2 WHERE id=?3",
        rusqlite::params![if status == "deleted" { "cancelled" } else { status }, status == "deleted", g.id]).unwrap();
    // Restore the actual v30 shape, including its trigger, before upgrading.
    db.conn()
        .execute_batch(
            "DROP TRIGGER IF EXISTS session_goals_mode_fence;
        ALTER TABLE session_goals DROP COLUMN active_scope_json;
        ALTER TABLE session_goals DROP COLUMN pause_requested;
        ALTER TABLE session_goals DROP COLUMN pending_budget_json;
        PRAGMA user_version=30;",
        )
        .unwrap();
    super::super::goal_lifecycle_migration::apply(db.conn()).unwrap();
    let row = stored_data(db.conn(), &g.id);
    (session.id, g, row)
}

fn stored_data(conn: &Connection, id: &str) -> Value {
    conn.query_row(
        "SELECT objective,criteria_json,progress_summary,rounds_started,token_usage,
        budget_json,outcomes_json,audit_json,elapsed_ms,deleted FROM session_goals WHERE id=?1",
        [id],
        |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, bool>(9)?
            ]))
        },
    )
    .unwrap()
}

#[test]
fn goals_refinement_v30_upgrade_keeps_data_and_original_backup() {
    for status in ["active", "paused", "completed", "deleted"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v30.sqlite");
        let (session, g, original) = v30_fixture(&path, status);
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.conn()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(stored_data(db.conn(), &g.id), original);
        assert_eq!(
            db.get_setting("app").unwrap().unwrap(),
            json!({"theme":"light"})
        );
        let flags: (bool, Option<String>) = db
            .conn()
            .query_row(
                "SELECT pause_requested,pending_budget_json FROM session_goals WHERE id=?1",
                [&g.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(flags, (false, None));
        if status == "deleted" {
            assert!(goals::get(&db, &session).unwrap().is_none());
        } else {
            let read = goals::get(&db, &session).unwrap().unwrap();
            assert_eq!(
                read.status.as_str(),
                if status == "active" { "paused" } else { status }
            );
            assert!(read.active_turn_id.is_none() && read.active_since_ms.is_none());
        }
        let backup_path = migration_backup_path(&path, 30);
        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            30
        );
        assert_eq!(stored_data(&backup, &g.id), original);
        assert!(backup
            .prepare("SELECT pending_budget_json,pause_requested FROM session_goals")
            .is_err());
        let claim: (String, i64) = backup
            .query_row(
                "SELECT active_turn_id,active_since_ms FROM session_goals WHERE id=?1",
                [&g.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(claim, ("v30-claim".into(), 5000));
        assert_eq!(
            backup
                .query_row(
                    "SELECT settled FROM goal_turns WHERE turn_id='v30-claim'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        let bytes = std::fs::read(&backup_path).unwrap();
        drop(db);
        let _db = Database::open(&path).unwrap();
        assert_eq!(std::fs::read(&backup_path).unwrap(), bytes);
    }
}

#[test]
fn goals_refinement_v30_backup_failure_leaves_version_shape_and_rows_intact() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v30.sqlite");
    let (_session, g, original) = v30_fixture(&path, "active");
    let backup_path = migration_backup_path(&path, 30);
    std::fs::create_dir(&backup_path).unwrap();
    assert!(Database::open(&path).is_err());
    let raw = Connection::open(&path).unwrap();
    assert_eq!(
        raw.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        30
    );
    assert_eq!(stored_data(&raw, &g.id), original);
    assert!(raw
        .prepare("SELECT pending_budget_json,pause_requested FROM session_goals")
        .is_err());
    drop(raw);
    std::fs::remove_dir(&backup_path).unwrap();
    let _db = Database::open(&path).unwrap();
    assert!(backup_path.is_file());
}

#[test]
fn goals_refinement_fresh_schema_guards_pause_intent_without_migration_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fresh.sqlite");
    let db = Database::open(&path).unwrap();
    let session =
        sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
    let g = goals::start(
        &db,
        serde_json::from_value(json!({"sessionId":session.id,"objective":"fresh"})).unwrap(),
    )
    .unwrap();
    assert!(!g.pause_requested && g.pending_budget.is_none());
    for invalid in ["-1", "2", "0.5", "'bad'", "NULL"] {
        assert!(db
            .conn()
            .execute(
                &format!("UPDATE session_goals SET pause_requested={invalid} WHERE id=?1"),
                [&g.id]
            )
            .is_err());
    }
    assert!(!migration_backup_path(&path, 30).exists());
}
