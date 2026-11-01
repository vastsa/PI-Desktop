use super::*;
use serde_json::{json, Value};

#[path = "approved_tests.rs"]
mod approved;
#[path = "deferred_lifecycle_tests.rs"]
mod deferred_lifecycle;
#[path = "lifecycle_tests.rs"]
mod lifecycle;
#[path = "live_refinement_tests.rs"]
mod live_refinement;

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}
fn fixture() -> (tempfile::TempDir, Database, String) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let session =
        crate::sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
    (dir, db, session.id)
}
fn start_default(db: &Database, session: &str) -> SessionGoal {
    start(db, decode(json!({"sessionId":session,"objective":"ship"}))).unwrap()
}
fn claim(db: &Database, g: &SessionGoal, turn: &str) -> SessionGoal {
    let (goal, claimed) = claim_turn(
        db,
        decode(json!({"sessionId":g.session_id,"goalId":g.id,
        "expectedRevision":g.revision,"turnId":turn})),
    )
    .unwrap();
    assert!(claimed);
    goal
}
fn control_goal(
    db: &Database,
    g: &SessionGoal,
    action: &str,
    budget: Option<Value>,
) -> Result<SessionGoal> {
    let mut input = json!({"sessionId":g.session_id,"goalId":g.id,
        "expectedRevision":g.revision,"action":action});
    if let Some(budget) = budget {
        input["budget"] = budget;
    }
    control(db, decode(input))
}
fn settle(db: &Database, g: &SessionGoal, turn: &str, tokens: i64) -> SessionGoal {
    settle_turn(
        db,
        decode(json!({"sessionId":g.session_id,"goalId":g.id,"turnId":turn,"tokens":tokens})),
    )
    .unwrap()
    .0
}
fn report_goal(
    db: &Database,
    g: &SessionGoal,
    turn: &str,
    status: &str,
    outcomes: Value,
) -> Result<SessionGoal> {
    let mut input = json!({"sessionId":g.session_id,"goalId":g.id,"turnId":turn,
        "progressSummary":"progress","status":status,"outcomes":outcomes});
    if status == "completed" {
        input["audit"] = json!({"version":1,"objective":g.objective,"remainingWork":[],
            "items":g.criteria.iter().map(|c| json!({"requirement":c,"outcome":"met","evidence":"test output"})).collect::<Vec<_>>()});
    }
    report(db, decode(input))
}
#[test]
fn goals_default_twenty_rounds_including_initial_and_explicit_budget_resume() {
    let (_dir, db, session) = fixture();
    assert!(get(&db, &session).unwrap().is_none());
    let mut g = start_default(&db, &session);
    assert_eq!(g.budget.max_turns, Some(20));
    assert_eq!(g.criteria, ["ship"]);
    for i in 0..20 {
        let turn = format!("turn-{i}");
        g = claim(&db, &g, &turn);
        g = settle(&db, &g, &turn, 10);
    }
    assert_eq!(g.rounds_started, 20);
    assert_eq!(g.token_usage, 200);
    assert_eq!(g.status, GoalStatus::BudgetExhausted);
    assert!(control_goal(&db, &g, "resume", None).is_err());
    g = control_goal(&db, &g, "resume", Some(json!({"maxTurns":21}))).unwrap();
    assert_eq!(g.status, GoalStatus::Active);
    g = claim(&db, &g, "last");
    g = settle(&db, &g, "last", 0);
    assert_eq!(g.status, GoalStatus::BudgetExhausted);
}
#[test]
fn goals_claim_revision_identity_and_exactly_once_settlement() {
    let (_dir, db, session) = fixture();
    let original = start_default(&db, &session);
    let g = claim(&db, &original, "turn");
    for revision in [original.revision, g.revision] {
        let (_, claimed) = claim_turn(
            &db,
            decode(json!({"sessionId":session,"goalId":g.id,
            "expectedRevision":revision,"turnId":"turn"})),
        )
        .unwrap();
        assert!(!claimed);
    }
    assert!(control_goal(&db, &original, "pause", None).is_err());
    let settled = settle(&db, &g, "turn", 13);
    let duplicate = settle(&db, &g, "turn", 999);
    assert_eq!(duplicate.token_usage, 13);
    assert_eq!(duplicate.revision, settled.revision);
    assert_eq!(duplicate.rounds_started, 1);
    let (_, claimed) = claim_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,
        "expectedRevision":settled.revision,"turnId":"turn"})),
    )
    .unwrap();
    assert!(!claimed);
}
#[test]
fn goals_stop_report_settle_races_and_replacement_safety() {
    for action in ["stop", "cancel"] {
        let (_dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "turn");
        let stopped = control_goal(&db, &g, action, None).unwrap();
        assert_eq!(stopped.active_turn_id.as_deref(), Some("turn"));
        assert!(control_goal(&db, &stopped, "resume", None).is_err());
        assert!(report_goal(&db, &stopped, "turn", "active", json!([])).is_err());
        let replacement = start(
            &db,
            decode(json!({"sessionId":session,"objective":"replacement"})),
        )
        .unwrap();
        assert!(
            repository::owned_for_settlement(db.conn(), &session, &g.id)
                .unwrap()
                .deleted
        );
        let settled = settle(&db, &stopped, "turn", 17);
        assert_eq!(settled.status, GoalStatus::Cancelled);
        assert!(settled.active_turn_id.is_none());
        assert_eq!(settled.token_usage, 17);
        settle(&db, &settled, "turn", 100);
        assert_eq!(get(&db, &session).unwrap().unwrap().id, replacement.id);
        assert_eq!(get(&db, &session).unwrap().unwrap().token_usage, 0);
    }
}
#[test]
fn goals_completion_requires_exact_evidence_and_live_claim() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "turn");
    for outcomes in [
        json!([]),
        json!([{"criterion":"ship","outcome":"unmet","evidence":"x"}]),
        json!([{"criterion":"ship","outcome":"met","evidence":" "}]),
        json!([{"criterion":"wrong","outcome":"met","evidence":"x"}]),
        json!([{"criterion":"ship","outcome":"met","evidence":"x"},{"criterion":"ship","outcome":"met","evidence":"x"}]),
    ] {
        assert!(report_goal(&db, &g, "turn", "completed", outcomes).is_err());
    }
    assert!(report_goal(&db, &g, "wrong", "active", json!([])).is_err());
    let mut wrong = g.clone();
    wrong.id = "wrong".into();
    assert!(report_goal(&db, &wrong, "turn", "active", json!([])).is_err());
    let completed = report_goal(
        &db,
        &g,
        "turn",
        "completed",
        json!([{"criterion":"ship","outcome":"met","evidence":"test passed"}]),
    )
    .unwrap();
    assert!(control_goal(&db, &completed, "resume", None).is_err());
    assert!(report_goal(&db, &completed, "turn", "active", json!([])).is_err());
    let done = settle(&db, &completed, "turn", 20);
    assert_eq!(done.status, GoalStatus::Completed);
    assert_ne!(start_default(&db, &session).id, g.id);
}

#[test]
fn goals_restart_pauses_without_replaying_or_losing_history() {
    let (dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "lost-turn");
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let recovered = get(&db, &session).unwrap().unwrap();
    assert_eq!(recovered.status, GoalStatus::Paused);
    assert_eq!(recovered.stop_reason.as_deref(), Some("host_restarted"));
    assert!(recovered.active_turn_id.is_none());
    assert_eq!(recovered.rounds_started, 1);
    assert_eq!(recovered.revision, g.revision + 1);
    assert!(validate_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,"turnId":"lost-turn"}))
    )
    .is_err());
    let resumed = control_goal(&db, &recovered, "resume", None).unwrap();
    let claimed = claim(&db, &resumed, "new-turn");
    let stale_settle = settle(&db, &g, "lost-turn", 99);
    assert_eq!(stale_settle.active_turn_id, claimed.active_turn_id);
    assert_eq!(stale_settle.token_usage, 99);
    assert_eq!(stale_settle.revision, claimed.revision + 1);
    assert_eq!(stale_settle.status, GoalStatus::Active);
    let duplicate = settle(&db, &g, "lost-turn", 99);
    assert_eq!(duplicate.token_usage, 99);
    assert_eq!(duplicate.revision, stale_settle.revision);
}

#[test]
fn goals_mode_switch_is_atomic_and_preserves_claim_even_with_engine_turn_running() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "goal-turn");
    let engine = crate::sessions::begin_turn(&db, &session, None, None).unwrap();
    crate::sessions::configure_session_with_thinking(
        &db, &session, "agent", None, None, None, None,
    )
    .unwrap();
    let unchanged = get(&db, &session).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&unchanged).unwrap(),
        serde_json::to_value(&g).unwrap()
    );
    validate_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,"turnId":"goal-turn"})),
    )
    .unwrap();
    let reported = report_goal(&db, &unchanged, "goal-turn", "active", json!([])).unwrap();
    let stopped = control_goal(&db, &reported, "stop", None).unwrap();
    crate::sessions::end_turn(&db, &engine, "aborted", None, None, false).unwrap();
    let settled = settle(&db, &stopped, "goal-turn", 4);
    assert_eq!(settled.status, GoalStatus::Paused);
    assert_eq!(
        control_goal(&db, &settled, "resume", None).unwrap().status,
        GoalStatus::Active
    );
}

#[test]
fn goals_start_admission_budget_and_strict_report_validation() {
    let (_dir, db, session) = fixture();
    for budget in [
        json!({"maxTurns":0}),
        json!({"maxTurns":10001}),
        json!({"maxTurns":1,"maxTokens":0}),
        json!({"maxTurns":1,"maxTokens":9007199254740992i64}),
    ] {
        assert!(start(
            &db,
            decode(json!({"sessionId":session,"objective":"x","budget":budget}))
        )
        .is_err());
    }
    for fields in [
        json!({"objective":""}),
        json!({"objective":"x","criteria":["same","same"]}),
        json!({"objective":"x","criteria":[" "]}),
        json!({"objective":"x".repeat(100001)}),
    ] {
        let mut input = fields;
        input["sessionId"] = json!(session);
        assert!(start(&db, decode(input)).is_err());
    }
    let engine = crate::sessions::begin_turn(&db, &session, None, None).unwrap();
    let waiting = start(&db, decode(json!({"sessionId":session,"objective":"x"}))).unwrap();
    let (_, admitted) = claim_turn(&db, decode(json!({"sessionId":session,"goalId":waiting.id,"expectedRevision":waiting.revision,"turnId":"busy"}))).unwrap();
    assert!(!admitted);
    crate::sessions::end_turn(&db, &engine, "completed", None, None, false).unwrap();
    let first = start_default(&db, &session);
    let g = start(
        &db,
        decode(json!({"sessionId":session,"objective":"again"})),
    )
    .unwrap();
    assert_ne!(g.id, first.id);
    assert!(control_goal(&db, &g, "pause", Some(json!({"maxTurns":99}))).is_err());
    for field in [
        "budget",
        "objective",
        "criteria",
        "permissions",
        "userAuthorized",
    ] {
        let mut report = json!({"sessionId":session,"goalId":g.id,"turnId":"turn","status":"active","progressSummary":"","outcomes":[]});
        report[field] = json!(true);
        assert!(serde_json::from_value::<ReportParams>(report).is_err());
    }
    assert!(serde_json::from_value::<StartParams>(
        json!({"sessionId":session,"objective":"x","budget":{"maxTurns":1.5}})
    )
    .is_err());
}

#[test]
fn goals_settlement_fail_closed_and_report_before_pause_permutations() {
    for (error, aborted, expected) in [
        (Some("failed"), false, GoalStatus::Blocked),
        (None, true, GoalStatus::Paused),
        (None, false, GoalStatus::Active),
    ] {
        let (_dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "turn");
        let reported = report_goal(&db, &g, "turn", "active", json!([])).unwrap();
        let (settled,changed)=settle_turn(&db,decode(json!({"sessionId":session,"goalId":g.id,"turnId":"turn","tokens":1,"error":error,"aborted":aborted}))).unwrap();
        assert!(changed);
        assert_eq!(settled.status, expected);
        assert!(settled.revision > reported.revision);
        assert!(report_goal(&db, &settled, "turn", "active", json!([])).is_err());
    }
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "turn");
    let reported = report_goal(&db, &g, "turn", "blocked", json!([])).unwrap();
    let paused = control_goal(&db, &reported, "pause", None).unwrap();
    let settled = settle(&db, &paused, "turn", 1);
    assert_eq!(settled.status, GoalStatus::Paused);
    let resumed = control_goal(
        &db,
        &settled,
        "resume",
        Some(json!({"maxTurns":20,"maxTokens":2})),
    )
    .unwrap();
    let g = claim(&db, &resumed, "next");
    let exhausted = settle(&db, &g, "next", 1);
    assert_eq!(exhausted.status, GoalStatus::BudgetExhausted);
    assert!(control_goal(&db, &exhausted, "resume", None).is_err());
    assert!(control_goal(
        &db,
        &exhausted,
        "resume",
        Some(json!({"maxTurns":30,"maxTokens":2}))
    )
    .is_err());
    assert!(control_goal(
        &db,
        &exhausted,
        "resume",
        Some(json!({"maxTurns":30,"maxTokens":3}))
    )
    .is_ok());
}

#[test]
fn goals_schema_v27_upgrade_preserves_legacy_approvals_without_promoting_them() {
    for version in [26, 27] {
        let (dir, db, session) = fixture();
        db.conn().execute("INSERT INTO plan_approvals(request_id,session_id,turn_id,tool_call_id,kind,plan_json,status,created_at,updated_at) VALUES ('historical',?1,'old-turn','old-call','goal','{}','rejected',1,1)", [&session]).unwrap();
        db.conn().execute_batch("DROP TRIGGER IF EXISTS session_goals_mode_fence; DROP TABLE turn_execution; DROP TRIGGER turn_execution_snapshot; DROP TABLE goal_turns; DROP TABLE session_goals;").unwrap();
        db.conn()
            .pragma_update(None, "user_version", version)
            .unwrap();
        drop(db);
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        assert_eq!(
            db.conn()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            crate::db::SCHEMA_VERSION
        );
        assert!(get(&db, &session).unwrap().is_none());
        let legacy: (String, String) = db
            .conn()
            .query_row(
                "SELECT kind,status FROM plan_approvals WHERE request_id='historical'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(legacy, ("goal".into(), "rejected".into()));
        assert!(crate::db::migration_backup_path(&dir.path().join("test.sqlite"), 27).exists());
        let g = start_default(&db, &session);
        assert_eq!(g.status, GoalStatus::Active);
    }
}

#[test]
fn goals_legacy_pending_and_queued_approvals_block_start() {
    for (status, execution) in [
        ("pending", None),
        ("approved", Some("queued")),
        ("approved", Some("running")),
    ] {
        let (_dir, db, session) = fixture();
        db.conn().execute("INSERT INTO plan_approvals(request_id,session_id,turn_id,tool_call_id,kind,plan_json,status,execution_state,created_at,updated_at) VALUES ('old',?1,'turn','call','goal','{}',?2,?3,1,1)",params![session,status,execution]).unwrap();
        assert!(start(&db, decode(json!({"sessionId":session,"objective":"x"}))).is_err());
        assert!(get(&db, &session).unwrap().is_none());
    }
}

#[test]
fn goals_recovered_terminal_turn_accounts_only_its_original_goal() {
    let (dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "old-turn");
    let cancelled = control_goal(&db, &g, "cancel", None).unwrap();
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let old = get(&db, &session).unwrap().unwrap();
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT settled FROM goal_turns WHERE turn_id='old-turn'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(old.status, GoalStatus::Cancelled);
    assert!(old.active_turn_id.is_none());
    let replacement = claim(&db, &start_default(&db, &session), "replacement-turn");
    let accounted = settle(&db, &cancelled, "old-turn", 123);
    assert_eq!(accounted.id, cancelled.id);
    assert_eq!(accounted.status, GoalStatus::Cancelled);
    assert_eq!(accounted.token_usage, 123);
    let current = get(&db, &session).unwrap().unwrap();
    assert_eq!(current.id, replacement.id);
    assert_eq!(current.active_turn_id, replacement.active_turn_id);
    assert_eq!(current.token_usage, 0);
    assert_eq!(current.revision, replacement.revision);
}

#[test]
fn goals_claim_and_settlement_failures_rollback_the_whole_transaction() {
    let (_dir, db, session) = fixture();
    let g = start_default(&db, &session);
    db.conn().execute_batch("CREATE TEMP TRIGGER fail_goal_save BEFORE UPDATE ON session_goals BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(claim_turn(
        &db,
        decode(
            json!({"sessionId":session,"goalId":g.id,"turnId":"turn","expectedRevision":g.revision})
        )
    )
    .is_err());
    assert_eq!(get(&db, &session).unwrap().unwrap().rounds_started, 0);
    assert_eq!(
        db.conn()
            .query_row("SELECT COUNT(*) FROM goal_turns", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    db.conn()
        .execute_batch("DROP TRIGGER fail_goal_save;")
        .unwrap();
    let g = claim(&db, &g, "turn");
    db.conn().execute_batch("CREATE TEMP TRIGGER fail_goal_save BEFORE UPDATE ON session_goals BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(settle_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,"turnId":"turn","tokens":5}))
    )
    .is_err());
    let current = get(&db, &session).unwrap().unwrap();
    assert_eq!(current.active_turn_id.as_deref(), Some("turn"));
    assert_eq!(current.token_usage, 0);
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT settled FROM goal_turns WHERE turn_id='turn'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db.conn()
        .execute_batch("DROP TRIGGER fail_goal_save;")
        .unwrap();
    assert_eq!(settle(&db, &g, "turn", 5).token_usage, 5);
}

#[test]
fn goals_multicriterion_completion_and_foreign_turns_are_fenced() {
    let (_dir, db, session) = fixture();
    let g = start(
        &db,
        decode(
            json!({"sessionId":session,"objective":"ship","criteria":["tests pass","review done"]}),
        ),
    )
    .unwrap();
    let g = claim(&db, &g, "one-turn");
    assert!(report_goal(
        &db,
        &g,
        "one-turn",
        "completed",
        json!([{"criterion":"tests pass","outcome":"met","evidence":"passed"}])
    )
    .is_err());
    let other =
        crate::sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
    let other_goal = start_default(&db, &other.id);
    let (_, claimed) = claim_turn(&db, decode(json!({"sessionId":other.id,"goalId":other_goal.id,"expectedRevision":other_goal.revision,"turnId":"one-turn"}))).unwrap();
    assert!(!claimed);
    assert!(settle_turn(
        &db,
        decode(json!({"sessionId":other.id,"goalId":g.id,"turnId":"one-turn","tokens":5}))
    )
    .is_err());
    assert!(settle_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,"turnId":"one-turn","tokens":-1}))
    )
    .is_err());
    let completed = report_goal(
        &db,
        &g,
        "one-turn",
        "completed",
        json!([
            {"criterion":"review done","outcome":"met","evidence":"review report"},
            {"criterion":"tests pass","outcome":"met","evidence":"test output"}
        ]),
    )
    .unwrap();
    let (settled, _) = settle_turn(&db, decode(json!({"sessionId":session,"goalId":g.id,"turnId":"one-turn","tokens":5,"error":"late error","aborted":true}))).unwrap();
    assert_eq!(settled.status, completed.status);
}
