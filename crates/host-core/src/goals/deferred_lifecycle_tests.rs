use super::*;

#[test]
fn goals_refinement_restart_applies_pending_budget_clears_pause_without_replay() {
    for budget in [
        json!({"maxTurns":1,"maxTokens":2}),
        json!({"maxTurns":null}),
    ] {
        let (dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "interrupted");
        let staged = control_goal(&db, &g, "budget", Some(budget.clone())).unwrap();
        let requested = control_goal(&db, &staged, "pause", None).unwrap();
        assert!(requested.pause_requested);
        drop(db);
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let recovered = get(&db, &session).unwrap().unwrap();
        assert_eq!(recovered.status, GoalStatus::Paused);
        assert_eq!(serde_json::to_value(&recovered).unwrap()["budget"], budget);
        assert!(recovered.pending_budget.is_none() && !recovered.pause_requested);
        assert!(recovered.active_turn_id.is_none());
        assert_eq!((recovered.rounds_started, recovered.token_usage), (1, 0));
        let late = settle(&db, &g, "interrupted", 3);
        assert_eq!(late.status, GoalStatus::Paused);
        assert_eq!(late.token_usage, 3);
        assert!(late.pending_budget.is_none());
        let duplicate = settle(&db, &g, "interrupted", 99);
        assert_eq!(duplicate.revision, late.revision);
        assert_eq!(duplicate.token_usage, 3);
        drop(db);
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        assert_eq!(get(&db, &session).unwrap().unwrap().revision, late.revision);
    }
}

#[test]
fn goals_refinement_late_recovered_usage_does_not_consume_new_claim_budget_or_pause() {
    let (_dir, db, session) = fixture();
    let old = claim(&db, &start_default(&db, &session), "old");
    let staged = control_goal(&db, &old, "budget", Some(json!({"maxTurns":null}))).unwrap();
    recover(&db).unwrap();
    let recovered = get(&db, &session).unwrap().unwrap();
    assert!(recovered.budget.max_turns.is_none());
    let resumed = control_goal(&db, &recovered, "resume", None).unwrap();
    let next = claim(&db, &resumed, "next");
    let pending = control_goal(&db, &next, "budget", Some(json!({"maxTurns":2}))).unwrap();
    let requested = control_goal(&db, &pending, "pause", None).unwrap();
    let late = settle(&db, &staged, "old", 3);
    assert_eq!(late.status, GoalStatus::Active);
    assert_eq!(late.active_turn_id, requested.active_turn_id);
    assert!(late.budget.max_turns.is_none() && late.pause_requested);
    assert_eq!(late.pending_budget.unwrap().max_turns, Some(2));
    let done = settle(&db, &requested, "next", 4);
    assert_eq!(done.status, GoalStatus::Paused);
    assert_eq!(done.token_usage, 7);
    assert_eq!(done.budget.max_turns, Some(2));
    assert!(done.pending_budget.is_none() && !done.pause_requested);
}

#[test]
fn goals_refinement_delete_discards_staged_intent_and_never_revives_after_recovery() {
    let (dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "removed");
    let staged = control_goal(&db, &g, "budget", Some(json!({"maxTurns":null}))).unwrap();
    let requested = control_goal(&db, &staged, "pause", None).unwrap();
    let removed = control_goal(&db, &requested, "delete", None).unwrap();
    assert!(removed.deleted && removed.pending_budget.is_none() && !removed.pause_requested);
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    assert!(get(&db, &session).unwrap().is_none());
    let replacement = start_default(&db, &session);
    let late = settle(&db, &removed, "removed", 3);
    assert!(late.deleted && late.pending_budget.is_none() && !late.pause_requested);
    assert_eq!(late.budget.max_turns, Some(20));
    assert_eq!(late.status, GoalStatus::Cancelled);
    assert_eq!(get(&db, &session).unwrap().unwrap().id, replacement.id);
}

#[test]
fn goals_refinement_settlement_rollback_preserves_usage_claim_and_deferred_intent() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "live");
    let staged = control_goal(&db, &g, "budget", Some(json!({"maxTurns":1}))).unwrap();
    let requested = control_goal(&db, &staged, "pause", None).unwrap();
    let before = serde_json::to_value(&requested).unwrap();
    db.conn().execute_batch("CREATE TEMP TRIGGER fail_settle BEFORE UPDATE ON session_goals BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(settle_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,"turnId":"live","tokens":3}))
    )
    .is_err());
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        before
    );
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT settled FROM goal_turns WHERE turn_id='live'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db.conn()
        .execute_batch("DROP TRIGGER fail_settle;")
        .unwrap();
    let done = settle(&db, &requested, "live", 3);
    assert_eq!(done.status, GoalStatus::Paused);
    assert_eq!(done.budget.max_turns, Some(1));
    assert_eq!(done.token_usage, 3);
    assert!(done.pending_budget.is_none() && !done.pause_requested);
}

#[test]
fn goals_refinement_budget_updates_reject_invalid_fields_revisions_and_terminal_goals() {
    let (_dir, db, session) = fixture();
    let g = start_default(&db, &session);
    for budget in [
        json!({"maxTurns":0}),
        json!({"maxTurns":10001}),
        json!({"maxTurns":null,"maxTokens":0}),
    ] {
        assert_eq!(
            control_goal(&db, &g, "budget", Some(budget))
                .unwrap_err()
                .to_string(),
            "GOAL_INVALID_BUDGET"
        );
    }
    assert_eq!(
        control_goal(&db, &g, "budget", None)
            .unwrap_err()
            .to_string(),
        "GOAL_INVALID_BUDGET"
    );
    for budget in [
        Value::Null,
        json!({}),
        json!({"maxTurns":null,"maxTokens":null}),
    ] {
        assert!(
            serde_json::from_value::<ControlParams>(json!({"sessionId":session,"goalId":g.id,
            "expectedRevision":g.revision,"action":"budget","budget":budget}))
            .is_err()
        );
    }
    assert_eq!(get(&db, &session).unwrap().unwrap().revision, g.revision);
    let cancelled = control_goal(&db, &g, "cancel", None).unwrap();
    assert_eq!(
        control_goal(&db, &cancelled, "budget", Some(json!({"maxTurns":null})))
            .unwrap_err()
            .to_string(),
        "GOAL_TERMINAL"
    );
}

#[test]
fn goals_refinement_budget_staged_on_stopped_claim_applies_without_resuming() {
    for status in ["stop", "blocked", "completed"] {
        let (_dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "live");
        let g = control_goal(&db, &g, "pause", None).unwrap();
        let stopped = match status {
            "stop" => control_goal(&db, &g, "stop", None).unwrap(),
            "blocked" => report_goal(&db, &g, "live", "blocked", json!([])).unwrap(),
            _ => report_goal(
                &db,
                &g,
                "live",
                "completed",
                json!([{"criterion":"ship","outcome":"met","evidence":"verified"}]),
            )
            .unwrap(),
        };
        assert!(!stopped.pause_requested);
        if status == "completed" {
            assert_eq!(
                control_goal(&db, &stopped, "budget", Some(json!({"maxTurns":null})))
                    .unwrap_err()
                    .to_string(),
                "GOAL_TERMINAL"
            );
            assert_eq!(
                settle(&db, &stopped, "live", 3).status,
                GoalStatus::Completed
            );
            continue;
        }
        let staged = control_goal(&db, &stopped, "budget", Some(json!({"maxTurns":null}))).unwrap();
        assert!(staged.pending_budget.is_some());
        assert_eq!(staged.budget.max_turns, Some(20));
        let done = settle(&db, &staged, "live", 3);
        assert_eq!(done.status, stopped.status);
        assert!(done.budget.max_turns.is_none() && done.pending_budget.is_none());
    }
}
