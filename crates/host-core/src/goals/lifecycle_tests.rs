use super::*;

fn edit(db: &Database, goal: &SessionGoal, objective: &str) -> Result<SessionGoal> {
    control(
        db,
        decode(json!({"sessionId":goal.session_id,"goalId":goal.id,
        "expectedRevision":goal.revision,"action":"edit","objective":objective})),
    )
}

#[test]
fn goals_extension_edit_waits_for_settlement_resets_reports_and_preserves_authorization_limits() {
    for status in ["paused", "blocked", "budget_exhausted"] {
        let (_dir, db, session) = fixture();
        let original = start(&db, decode(json!({"sessionId":session,"objective":"ship",
            "budget":{"maxTurns":if status == "budget_exhausted" { 1 } else { 20 },"maxTokens":100}}))).unwrap();
        let g = claim(&db, &original, "edit-turn");
        assert_eq!(
            edit(&db, &g, "new").unwrap_err().to_string(),
            "GOAL_TURN_IN_FLIGHT"
        );
        let reported = report(
            &db,
            decode(
                json!({"sessionId":session,"goalId":g.id,"turnId":"edit-turn",
            "progressSummary":"old report","status":if status == "budget_exhausted" { "active" } else { "blocked" },
            "outcomes":[{"criterion":"ship","outcome":"unmet","evidence":"old evidence"}],
            "audit":{"version":1,"objective":"ship","remainingWork":["ship"],
            "items":[{"requirement":"ship","outcome":"unmet","evidence":"old evidence"}]}}),
            ),
        )
        .unwrap();
        assert_eq!(
            edit(&db, &reported, "new").unwrap_err().to_string(),
            "GOAL_TURN_IN_FLIGHT"
        );
        let g = settle(&db, &reported, "edit-turn", 37);
        let before = if status == "paused" {
            control_goal(&db, &g, "pause", None).unwrap()
        } else {
            g.clone()
        };
        assert_eq!(before.status.as_str(), status);
        let exact = "  New scope\nwith exact formatting  ";
        let edited = edit(&db, &before, exact).unwrap();
        assert_eq!(edited.objective, exact);
        assert_eq!(edited.criteria, [exact]);
        assert_eq!(edited.status, GoalStatus::Paused);
        assert!(
            edited.progress_summary.is_empty()
                && edited.outcomes.is_empty()
                && edited.audit.is_none()
        );
        assert_eq!(edited.rounds_started, 1);
        assert_eq!(edited.token_usage, 37);
        assert_eq!(
            serde_json::to_value(&edited.budget).unwrap(),
            serde_json::to_value(&before.budget).unwrap()
        );
        let duplicate = settle(&db, &g, "edit-turn", 999);
        assert_eq!(duplicate.objective, exact);
        assert_eq!(duplicate.revision, edited.revision);
        assert_eq!(duplicate.token_usage, 37);
        assert!(report_goal(&db, &g, "edit-turn", "active", json!([])).is_err());
        if status == "budget_exhausted" {
            assert_eq!(
                control_goal(&db, &edited, "resume", None)
                    .unwrap_err()
                    .to_string(),
                "GOAL_BUDGET_EXHAUSTED"
            );
            assert_eq!(
                control_goal(
                    &db,
                    &edited,
                    "resume",
                    Some(json!({"maxTurns":2,"maxTokens":100}))
                )
                .unwrap()
                .status,
                GoalStatus::Active
            );
        } else {
            assert_eq!(
                control_goal(&db, &edited, "resume", None).unwrap().status,
                GoalStatus::Active
            );
        }
    }
}

#[test]
fn goals_extension_control_requires_current_revision_owned_identity_and_exact_fields() {
    let (_dir, db, session) = fixture();
    let g = start_default(&db, &session);
    assert_eq!(
        edit(&db, &g, "new").unwrap_err().to_string(),
        "GOAL_NOT_EDITABLE"
    );
    let paused = control_goal(&db, &g, "pause", None).unwrap();
    assert_eq!(
        edit(&db, &g, "stale").unwrap_err().to_string(),
        "GOAL_STALE_REVISION"
    );
    let other =
        crate::sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
    for action in ["edit", "delete"] {
        let mut input = json!({"sessionId":other.id,"goalId":paused.id,"expectedRevision":paused.revision,"action":action});
        if action == "edit" {
            input["objective"] = json!("new");
        }
        assert_eq!(
            control(&db, decode(input)).unwrap_err().to_string(),
            "GOAL_NOT_FOUND"
        );
    }
    for action in ["pause", "resume", "cancel", "delete"] {
        assert_eq!(
            control(
                &db,
                decode(
                    json!({"sessionId":session,"goalId":g.id,"expectedRevision":paused.revision,
            "action":action,"objective":"not allowed"})
                )
            )
            .unwrap_err()
            .to_string(),
            "GOAL_OBJECTIVE_REQUIRES_EDIT"
        );
    }
    for objective in ["".to_string(), "  ".to_string(), "x".repeat(100_001)] {
        assert_eq!(
            edit(&db, &paused, &objective).unwrap_err().to_string(),
            "GOAL_INVALID_TEXT"
        );
    }
    assert_eq!(
        control(
            &db,
            decode(
                json!({"sessionId":session,"goalId":g.id,"expectedRevision":paused.revision,
        "action":"edit"})
            )
        )
        .unwrap_err()
        .to_string(),
        "GOAL_INVALID_TEXT"
    );
    assert_eq!(
        control(
            &db,
            decode(
                json!({"sessionId":session,"goalId":g.id,"expectedRevision":paused.revision,
        "action":"edit","objective":"new","budget":{"maxTurns":99}})
            )
        )
        .unwrap_err()
        .to_string(),
        "GOAL_BUDGET_REQUIRES_RESUME"
    );
    assert!(serde_json::from_value::<ControlParams>(
        json!({"sessionId":session,"goalId":g.id,"action":"edit","objective":"new"})
    )
    .is_err());
    assert_eq!(
        get(&db, &session).unwrap().unwrap().revision,
        paused.revision
    );
}

#[test]
fn goals_extension_terminal_edit_rejected_delete_allowed_and_rows_retained() {
    for terminal in ["completed", "cancelled"] {
        let (_dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "terminal-turn");
        let g = if terminal == "completed" {
            report_goal(
                &db,
                &g,
                "terminal-turn",
                "completed",
                json!([{"criterion":"ship","outcome":"met","evidence":"passed"}]),
            )
            .unwrap()
        } else {
            control_goal(&db, &g, "cancel", None).unwrap()
        };
        assert_eq!(
            edit(&db, &g, "new").unwrap_err().to_string(),
            "GOAL_TERMINAL"
        );
        let deleted = control_goal(&db, &g, "delete", None).unwrap();
        assert!(get(&db, &session).unwrap().is_none());
        assert_eq!(deleted.active_turn_id.as_deref(), Some("terminal-turn"));
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT COUNT(*) FROM goal_turns WHERE goal_id=?1",
                    [&g.id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(start(
            &db,
            decode(json!({"sessionId":session,"objective":"too soon"}))
        )
        .is_err());
        let accounted = settle(&db, &deleted, "terminal-turn", 13);
        assert!(accounted.deleted);
        assert_eq!(accounted.status, GoalStatus::Cancelled);
        assert_eq!(accounted.token_usage, 13);
        assert!(get(&db, &session).unwrap().is_none());
        let replacement = start_default(&db, &session);
        assert_ne!(replacement.id, g.id);
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT COUNT(*) FROM session_goals WHERE session_id=?1",
                    [&session],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }
}

#[test]
fn goals_extension_late_recovered_usage_cannot_overwrite_edited_scope_or_new_claim() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "old");
    recover(&db).unwrap();
    let paused = get(&db, &session).unwrap().unwrap();
    let edited = edit(&db, &paused, "replacement scope").unwrap();
    let resumed = control_goal(&db, &edited, "resume", None).unwrap();
    let next = claim(&db, &resumed, "new");
    let (late, changed) = settle_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,
        "turnId":"old","tokens":5,"error":"old failure","aborted":true})),
    )
    .unwrap();
    assert!(changed);
    assert_eq!(late.objective, edited.objective);
    assert_eq!(late.active_turn_id, next.active_turn_id);
    assert_eq!(late.status, GoalStatus::Active);
    assert!(late.progress_summary.is_empty() && late.outcomes.is_empty());
}

#[test]
fn goals_extension_timer_checkpoints_active_intervals_not_pause_or_duplicate_settlement() {
    let (_dir, db, session) = fixture();
    let g = clock::at(1_000, || start_default(&db, &session));
    assert_eq!((g.elapsed_ms, g.active_since_ms), (0, Some(1_000)));
    let g = clock::at(1_500, || claim(&db, &g, "timed"));
    assert_eq!((g.elapsed_ms, g.active_since_ms), (500, Some(1_500)));
    let g = clock::at(2_250, || {
        report_goal(&db, &g, "timed", "active", json!([])).unwrap()
    });
    assert_eq!((g.elapsed_ms, g.active_since_ms), (1_250, Some(2_250)));
    let paused = clock::at(3_500, || control_goal(&db, &g, "pause", None).unwrap());
    assert_eq!((paused.elapsed_ms, paused.active_since_ms), (2_500, None));
    let settled = clock::at(6_000, || settle(&db, &paused, "timed", 2));
    assert_eq!(settled.elapsed_ms, 2_500);
    let duplicate = clock::at(8_000, || settle(&db, &paused, "timed", 99));
    assert_eq!(duplicate.revision, settled.revision);
    assert_eq!(duplicate.elapsed_ms, 2_500);
    let paused = clock::at(9_000, || {
        control_goal(&db, &settled, "pause", None).unwrap()
    });
    assert_eq!(paused.elapsed_ms, 2_500);
    let resumed = clock::at(10_000, || {
        control_goal(&db, &paused, "resume", None).unwrap()
    });
    assert_eq!(
        (resumed.elapsed_ms, resumed.active_since_ms),
        (2_500, Some(10_000))
    );
    assert_eq!(
        clock::at(99_000, || get(&db, &session).unwrap().unwrap()).active_since_ms,
        Some(10_000)
    );
    let claimed = clock::at(11_000, || claim(&db, &resumed, "resumed"));
    assert_eq!(claimed.elapsed_ms, 3_500);
    let backwards = clock::at(10_500, || {
        report_goal(&db, &claimed, "resumed", "active", json!([])).unwrap()
    });
    assert_eq!(
        (backwards.elapsed_ms, backwards.active_since_ms),
        (3_500, Some(11_000))
    );
    let stopped = clock::at(11_250, || {
        control_goal(&db, &backwards, "cancel", None).unwrap()
    });
    assert_eq!((stopped.elapsed_ms, stopped.active_since_ms), (3_750, None));
    assert_eq!(
        serde_json::to_value(&stopped).unwrap()["elapsedSeconds"],
        json!(3.75)
    );
}

#[test]
fn goals_extension_timer_stops_on_every_lifecycle_exit_and_mode_fence() {
    for reason in [
        "pause",
        "cancel",
        "delete",
        "blocked",
        "completed",
        "error",
        "aborted",
        "budget",
        "mode",
    ] {
        let (_dir, db, session) = fixture();
        let g = clock::at(1_000, || {
            start(
                &db,
                decode(json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":1}})),
            )
            .unwrap()
        });
        let g = clock::at(1_500, || claim(&db, &g, "exit"));
        let stopped = clock::at(3_750, || {
            match reason {
            "pause" | "cancel" | "delete" => control_goal(&db, &g, reason, None).unwrap(),
            "blocked" => report_goal(&db, &g, "exit", "blocked", json!([])).unwrap(),
            "completed" => report_goal(&db, &g, "exit", "completed", json!([{"criterion":"ship","outcome":"met","evidence":"passed"}])).unwrap(),
            "mode" => {
                crate::sessions::configure_session_with_thinking(&db, &session, "agent", None, None, None, None).unwrap();
                get(&db, &session).unwrap().unwrap()
            }
            _ => settle_turn(&db, decode(json!({"sessionId":session,"goalId":g.id,"turnId":"exit","tokens":1,
                "error":if reason == "error" { Some("failure") } else { None },"aborted":reason == "aborted"}))).unwrap().0,
        }
        });
        assert_eq!(
            (stopped.elapsed_ms, stopped.active_since_ms),
            (2_750, None),
            "{reason}"
        );
        assert_ne!(stopped.status, GoalStatus::Active);
    }
}

#[test]
fn goals_extension_timer_restart_uses_last_checkpoint_not_downtime_and_legacy_defaults_zero() {
    let (dir, db, session) = fixture();
    let g = clock::at(1_000, || start_default(&db, &session));
    let g = clock::at(2_500, || claim(&db, &g, "lost"));
    assert_eq!(g.elapsed_ms, 1_500);
    drop(db);
    let db = clock::at(1_000_000, || {
        Database::open(&dir.path().join("test.sqlite")).unwrap()
    });
    let recovered = get(&db, &session).unwrap().unwrap();
    assert_eq!(
        (recovered.elapsed_ms, recovered.active_since_ms),
        (1_500, None)
    );
    assert_eq!(recovered.status, GoalStatus::Paused);
    let settled = clock::at(2_000_000, || settle(&db, &g, "lost", 3));
    assert_eq!((settled.elapsed_ms, settled.active_since_ms), (1_500, None));
    let resumed = clock::at(3_000_000, || {
        control_goal(&db, &settled, "resume", None).unwrap()
    });
    let stopped = clock::at(3_000_500, || {
        control_goal(&db, &resumed, "pause", None).unwrap()
    });
    assert_eq!(stopped.elapsed_ms, 2_000);
    let mut legacy = serde_json::to_value(&stopped).unwrap();
    legacy.as_object_mut().unwrap().remove("elapsedSeconds");
    let legacy: SessionGoal = decode(legacy);
    assert_eq!((legacy.elapsed_ms, legacy.active_since_ms), (0, None));
    let mut saturated = resumed;
    saturated.elapsed_ms = MAX_SAFE_INTEGER - 1;
    clock::checkpoint(&mut saturated, MAX_SAFE_INTEGER);
    assert_eq!(saturated.elapsed_ms, MAX_SAFE_INTEGER);
}
