use super::*;

fn validate(db: &Database, goal: &SessionGoal, turn: &str) -> Result<SessionGoal> {
    validate_turn(
        db,
        decode(json!({"sessionId":goal.session_id,"goalId":goal.id,"turnId":turn})),
    )
}

#[test]
fn goals_immediate_pause_commits_status_and_stops_elapsed_clock_before_closeout() {
    let (dir, db, session) = fixture();
    let g = clock::at(1_000, || start_default(&db, &session));
    let g = clock::at(2_000, || claim(&db, &g, "live"));
    let paused = clock::at(3_000, || control_goal(&db, &g, "pause", None).unwrap());
    assert_eq!(paused.status, GoalStatus::Paused);
    assert_eq!(paused.stop_reason.as_deref(), Some("user_paused"));
    assert!(paused.pause_requested);
    assert_eq!(paused.active_turn_id, g.active_turn_id);
    assert_eq!(paused.active_scope, g.active_scope);
    assert_eq!((paused.elapsed_ms, paused.active_since_ms), (2_000, None));
    let reader = rusqlite::Connection::open(dir.path().join("test.sqlite")).unwrap();
    let durable: (String, String, bool, String) = reader.query_row(
        "SELECT status,stop_reason,pause_requested,active_turn_id FROM session_goals WHERE id=?1",
        [&g.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).unwrap();
    assert_eq!(
        durable,
        ("paused".into(), "user_paused".into(), true, "live".into())
    );
    let (_, admitted) = claim_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,
        "expectedRevision":paused.revision,"turnId":"not-admitted"})),
    )
    .unwrap();
    assert!(!admitted);
    assert_eq!(
        control_goal(&db, &paused, "resume", None)
            .unwrap_err()
            .to_string(),
        "GOAL_TURN_IN_FLIGHT"
    );
    assert_eq!(
        validate(&db, &paused, "live").unwrap().revision,
        paused.revision
    );
    let done = clock::at(9_000, || settle(&db, &paused, "live", 3));
    assert_eq!((done.elapsed_ms, done.active_since_ms), (2_000, None));
}

#[test]
fn goals_immediate_pause_validates_only_same_live_unsettled_scoped_claim() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "live");
    let paused = control_goal(&db, &g, "pause", None).unwrap();
    validate(&db, &paused, "live").unwrap();
    assert!(validate(&db, &paused, "foreign").is_err());
    let mut foreign = paused.clone();
    foreign.session_id = "foreign".into();
    assert!(validate(&db, &foreign, "live").is_err());
    foreign = paused.clone();
    foreign.id = "foreign".into();
    assert!(validate(&db, &foreign, "live").is_err());
    db.conn()
        .execute("UPDATE goal_turns SET settled=1 WHERE turn_id='live'", [])
        .unwrap();
    assert!(validate(&db, &paused, "live").is_err());
    db.conn()
        .execute("UPDATE goal_turns SET settled=0 WHERE turn_id='live'", [])
        .unwrap();
    db.conn()
        .execute(
            "UPDATE session_goals SET active_scope_json=NULL WHERE id=?1",
            [&g.id],
        )
        .unwrap();
    assert!(validate(&db, &paused, "live").is_err());
}

#[test]
fn goals_immediate_pause_reports_preserve_intent_and_reject_completion_without_mutation() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "live");
    let mut paused = control_goal(&db, &g, "pause", None).unwrap();
    for status in ["active", "blocked"] {
        paused = report_goal(
            &db,
            &paused,
            "live",
            status,
            json!([{"criterion":"ship","outcome":"unmet","evidence":"closing"}]),
        )
        .unwrap();
        assert_eq!(paused.status, GoalStatus::Paused);
        assert_eq!(paused.stop_reason.as_deref(), Some("user_paused"));
        assert!(paused.pause_requested);
        assert_eq!(paused.progress_summary, "progress");
        validate(&db, &paused, "live").unwrap();
    }
    let before = serde_json::to_value(&paused).unwrap();
    assert_eq!(
        report_goal(
            &db,
            &paused,
            "live",
            "completed",
            json!([{"criterion":"ship","outcome":"met","evidence":"verified"}])
        )
        .unwrap_err()
        .to_string(),
        "GOAL_COMPLETION_UNVERIFIED"
    );
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        before
    );
}

#[test]
fn goals_immediate_pause_settlement_clears_claim_intent_applies_budget_and_counts_once_even_on_error(
) {
    for (error, aborted) in [
        (None, false),
        (Some("closing failed"), false),
        (None, true),
        (Some("closing failed"), true),
    ] {
        let (_dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "live");
        let staged =
            control_goal(&db, &g, "budget", Some(json!({"maxTurns":1,"maxTokens":2}))).unwrap();
        let paused = control_goal(&db, &staged, "pause", None).unwrap();
        let (done, changed) = settle_turn(
            &db,
            decode(json!({"sessionId":session,"goalId":g.id,
            "turnId":"live","tokens":7,"error":error,"aborted":aborted})),
        )
        .unwrap();
        assert!(changed);
        assert_eq!(done.status, GoalStatus::Paused);
        assert_eq!(done.stop_reason.as_deref(), Some("user_paused"));
        assert!(
            done.active_turn_id.is_none() && done.active_scope.is_none() && !done.pause_requested
        );
        assert!(done.pending_budget.is_none());
        assert_eq!(
            (done.budget.max_turns, done.budget.max_tokens),
            (Some(1), Some(2))
        );
        assert_eq!((done.token_usage, done.rounds_started), (7, 1));
        assert!(validate(&db, &paused, "live").is_err());
        let duplicate = settle(&db, &paused, "live", 100);
        assert_eq!(
            serde_json::to_value(duplicate).unwrap(),
            serde_json::to_value(done).unwrap()
        );
    }
}

#[test]
fn goals_immediate_pause_repeat_is_cas_safe_and_cannot_regrant_stopped_claim() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "live");
    let paused = control_goal(&db, &g, "pause", None).unwrap();
    assert_eq!(
        control_goal(&db, &g, "pause", None)
            .unwrap_err()
            .to_string(),
        "GOAL_STALE_REVISION"
    );
    let repeated = control_goal(&db, &paused, "pause", None).unwrap();
    assert_eq!(repeated.status, GoalStatus::Paused);
    assert!(repeated.pause_requested);
    assert_eq!(repeated.active_scope, g.active_scope);
    validate(&db, &repeated, "live").unwrap();
    let stopped = control_goal(&db, &repeated, "stop", None).unwrap();
    let repeated = control_goal(&db, &stopped, "pause", None).unwrap();
    assert!(!repeated.pause_requested);
    assert!(validate(&db, &repeated, "live").is_err());
    let settled = settle(&db, &repeated, "live", 0);
    let idle = control_goal(&db, &settled, "pause", None).unwrap();
    assert!(!idle.pause_requested);
    assert_eq!(idle.status, GoalStatus::Paused);
}

#[test]
fn goals_immediate_pause_stop_cancel_delete_revoke_closeout_but_keep_late_usage() {
    for action in ["stop", "cancel", "delete"] {
        let (_dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "live");
        let paused = control_goal(&db, &g, "pause", None).unwrap();
        let revoked = control_goal(&db, &paused, action, None).unwrap();
        assert!(!revoked.pause_requested);
        assert!(validate(&db, &revoked, "live").is_err());
        assert!(report_goal(&db, &revoked, "live", "active", json!([])).is_err());
        let done = settle(&db, &revoked, "live", 7);
        assert_eq!(done.status, revoked.status);
        assert_eq!(done.token_usage, 7);
        assert!(
            done.active_turn_id.is_none() && done.active_scope.is_none() && !done.pause_requested
        );
    }
}

#[test]
fn goals_immediate_pause_recovery_preserves_manual_pause_and_fences_replay() {
    let (dir, db, session) = fixture();
    let g = clock::at(1_000, || start_default(&db, &session));
    let g = clock::at(2_000, || claim(&db, &g, "live"));
    let g = clock::at(2_500, || {
        control_goal(&db, &g, "budget", Some(json!({"maxTurns":null}))).unwrap()
    });
    let paused = clock::at(3_000, || control_goal(&db, &g, "pause", None).unwrap());
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let recovered = get(&db, &session).unwrap().unwrap();
    assert_eq!(recovered.status, GoalStatus::Paused);
    assert_eq!(recovered.stop_reason.as_deref(), Some("user_paused"));
    assert_eq!(
        (recovered.elapsed_ms, recovered.active_since_ms),
        (2_000, None)
    );
    assert!(
        recovered.active_turn_id.is_none()
            && recovered.active_scope.is_none()
            && !recovered.pause_requested
    );
    assert!(recovered.budget.max_turns.is_none() && recovered.pending_budget.is_none());
    assert!(validate(&db, &paused, "live").is_err());
    let late = settle(&db, &paused, "live", 7);
    assert_eq!(late.status, GoalStatus::Paused);
    assert_eq!((late.token_usage, late.rounds_started), (7, 1));
    assert_eq!(settle(&db, &paused, "live", 99).revision, late.revision);
}

#[test]
fn goals_immediate_pause_replacement_revokes_old_claim_without_reviving_either_goal() {
    for pause_replacement in [false, true] {
        let (_dir, db, session) = fixture();
        let old = claim(&db, &start_default(&db, &session), "old");
        let paused = control_goal(&db, &old, "pause", None).unwrap();
        let mut next = start_default(&db, &session);
        if pause_replacement {
            next = control_goal(&db, &next, "pause", None).unwrap();
        }
        assert!(validate(&db, &paused, "old").is_err());
        let late = settle(&db, &paused, "old", 7);
        assert!(late.deleted && !late.pause_requested);
        assert_eq!(late.status, GoalStatus::Cancelled);
        assert_eq!(late.token_usage, 7);
        assert_eq!(
            serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
            serde_json::to_value(&next).unwrap()
        );
        assert_eq!(settle(&db, &paused, "old", 99).revision, late.revision);
    }
}
