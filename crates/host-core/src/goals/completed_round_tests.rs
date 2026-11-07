use super::*;

#[test]
fn goals_completed_rounds_increment_only_on_successful_exactly_once_settlement() {
    let (_dir, db, session) = fixture();
    let g = start(
        &db,
        decode(json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":1}})),
    )
    .unwrap();
    let g = claim(&db, &g, "first");
    assert_eq!(serde_json::to_value(&g).unwrap()["roundsCompleted"], 0);
    // Validation and progress/tool/model iterations cannot consume a round.
    for _ in 0..3 {
        validate_turn(
            &db,
            decode(json!({"sessionId":session,"goalId":g.id,"turnId":"first"})),
        )
        .unwrap();
    }
    let done = settle(&db, &g, "first", 10);
    assert_eq!(serde_json::to_value(&done).unwrap()["roundsCompleted"], 1);
    assert_eq!(done.status, GoalStatus::BudgetExhausted);
    assert_eq!(
        serde_json::to_value(settle(&db, &g, "first", 99)).unwrap(),
        serde_json::to_value(done).unwrap()
    );
}

#[test]
fn goals_completed_rounds_exclude_error_abort_and_recovered_usage_without_free_auto_retries() {
    for (error, aborted, recovery) in [
        (Some("failure"), false, false),
        (None, true, false),
        (None, false, true),
    ] {
        let (_dir, db, session) = fixture();
        let g = start(
            &db,
            decode(json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":1}})),
        )
        .unwrap();
        let g = claim(&db, &g, "first");
        if recovery {
            recover(&db).unwrap();
        }
        let (done, _) = settle_turn(&db, decode(json!({"sessionId":session,"goalId":g.id,"turnId":"first","tokens":10,"error":error,"aborted":aborted}))).unwrap();
        assert_eq!(serde_json::to_value(&done).unwrap()["roundsCompleted"], 0);
        assert_ne!(done.status, GoalStatus::Active);
        assert_eq!(done.token_usage, 10);
        let resumed = control_goal(&db, &done, "resume", None).unwrap();
        let next = claim(&db, &resumed, "second");
        let done = settle(&db, &next, "second", 2);
        assert_eq!(serde_json::to_value(&done).unwrap()["roundsCompleted"], 1);
        assert_eq!(done.status, GoalStatus::BudgetExhausted);
        assert_eq!(done.rounds_started, 2);
    }
}

#[test]
fn goals_completed_rounds_schema33_upgrade_backfills_only_proven_completed_conversations() {
    let (dir, db, session) = fixture();
    let g = start_default(&db, &session);
    let g = claim(&db, &g, "completed");
    let bind = |claim: &str| {
        crate::sessions::turn_execution::begin_goal_turn(
            &db,
            &session,
            None,
            None,
            decode(json!({"goalId":g.id,"turnId":claim,"provenance":"user-goal"})),
        )
        .unwrap()
    };
    let runtime = bind("completed");
    let g = settle(&db, &g, "completed", 5);
    crate::sessions::end_turn(&db, &runtime, "completed", None, None, false).unwrap();
    let g = claim(&db, &g, "aborted");
    let runtime = bind("aborted");
    let (g, _) = settle_turn(
        &db,
        decode(
            json!({"sessionId":session,"goalId":g.id,"turnId":"aborted","tokens":3,"aborted":true}),
        ),
    )
    .unwrap();
    crate::sessions::end_turn(&db, &runtime, "aborted", None, None, false).unwrap();
    let g = control_goal(&db, &g, "resume", None).unwrap();
    let g = claim(&db, &g, "unbound");
    let g = settle(&db, &g, "unbound", 2);
    let id = g.id.clone();
    db.conn()
        .execute_batch(
            "ALTER TABLE session_goals DROP COLUMN rounds_completed; PRAGMA user_version=32;",
        )
        .unwrap();
    drop(db);
    let path = dir.path().join("test.sqlite");
    let db = Database::open(&path).unwrap();
    let restored = get(&db, &session).unwrap().unwrap();
    assert_eq!(restored.id, id);
    assert_eq!(restored.rounds_completed, 1);
    assert_eq!(restored.rounds_started, 3);
    assert_eq!(restored.token_usage, 10);
    assert!(crate::db::migration_backup_path(&path, 32).exists());
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(get(&db, &session).unwrap().unwrap().rounds_completed, 1);
}
