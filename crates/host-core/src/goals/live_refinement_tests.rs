use super::*;

fn edit(db: &Database, goal: &SessionGoal, objective: &str) -> SessionGoal {
    control(
        db,
        decode(json!({"sessionId":goal.session_id,"goalId":goal.id,
        "expectedRevision":goal.revision,"action":"edit","objective":objective})),
    )
    .unwrap()
}

#[test]
fn goals_refinement_active_edit_preserves_claim_scope_and_defers_completion() {
    let (_dir, db, session) = fixture();
    let original = claim(&db, &start_default(&db, &session), "live");
    let original = report(
        &db,
        decode(
            json!({"sessionId":session,"goalId":original.id,"turnId":"live",
        "progressSummary":"old progress","status":"active",
        "outcomes":[{"criterion":"ship","outcome":"unmet","evidence":"old evidence"}],
        "audit":{"version":1,"objective":"ship","remainingWork":["finish"],
        "items":[{"requirement":"ship","outcome":"unmet","evidence":"old evidence"}]}}),
        ),
    )
    .unwrap();
    let edited = edit(&db, &original, "new exact scope");
    assert!(
        edited.progress_summary.is_empty() && edited.outcomes.is_empty() && edited.audit.is_none()
    );
    assert_eq!(edited.status, GoalStatus::Active);
    assert_eq!(edited.active_turn_id, original.active_turn_id);
    let refreshed = validate_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":edited.id,"turnId":"live"})),
    )
    .unwrap();
    assert_eq!(refreshed.objective, "new exact scope");
    assert_eq!(refreshed.active_scope.as_ref().unwrap().objective, "ship");
    let mut input = json!({"sessionId":session,"goalId":edited.id,"turnId":"live",
        "progressSummary":"done","status":"completed",
        "outcomes":[{"criterion":"new exact scope","outcome":"met","evidence":"new tests"}],
        "audit":{"version":1,"objective":"ship","remainingWork":[],
        "items":[{"requirement":"new exact scope","outcome":"met","evidence":"new tests"}]}});
    assert_eq!(
        report(&db, decode(input.clone())).unwrap_err().to_string(),
        "GOAL_COMPLETION_UNVERIFIED"
    );
    input["audit"]["objective"] = json!(edited.objective);
    assert_eq!(
        report(&db, decode(input.clone())).unwrap_err().to_string(),
        "GOAL_COMPLETION_UNVERIFIED"
    );
    let settled = settle(&db, &edited, "live", 7);
    let next = claim(&db, &settled, "next");
    input["turnId"] = json!("next");
    assert_eq!(
        next.active_scope.as_ref().unwrap().objective,
        edited.objective
    );
    let completed = report(&db, decode(input)).unwrap();
    assert_eq!(
        settle(&db, &completed, "next", 1).status,
        GoalStatus::Completed
    );
}

#[test]
fn goals_refinement_boundary_pause_keeps_current_turn_valid() {
    let (_dir, db, session) = fixture();
    let g = clock::at(1_000, || start_default(&db, &session));
    let g = clock::at(2_000, || claim(&db, &g, "live"));
    let requested = clock::at(3_000, || control_goal(&db, &g, "pause", None).unwrap());
    assert_eq!(requested.status, GoalStatus::Active);
    assert_eq!(
        serde_json::to_value(&requested).unwrap()["pauseRequested"],
        true
    );
    validate_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,"turnId":"live"})),
    )
    .unwrap();
    let reported = clock::at(4_000, || {
        report_goal(&db, &requested, "live", "active", json!([])).unwrap()
    });
    let paused = clock::at(5_000, || settle(&db, &reported, "live", 17));
    assert_eq!((paused.elapsed_ms, paused.active_since_ms), (4_000, None));
    assert!(!paused.pause_requested);
    assert_eq!(paused.status, GoalStatus::Paused);
    let (_, claimed) = claim_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,
        "expectedRevision":paused.revision,"turnId":"no-continuation"})),
    )
    .unwrap();
    assert!(!claimed);
}

#[test]
fn goals_refinement_budget_is_staged_until_usage_settles() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "live");
    let staged = control_goal(
        &db,
        &g,
        "budget",
        Some(json!({"maxTurns":null,"maxTokens":5})),
    )
    .unwrap();
    let wire = serde_json::to_value(&staged).unwrap();
    assert_eq!(wire["budget"], json!({"maxTurns":20}));
    assert_eq!(
        wire["pendingBudget"],
        json!({"maxTurns":null,"maxTokens":5})
    );
    validate_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,"turnId":"live"})),
    )
    .unwrap();
    let settled = settle(&db, &staged, "live", 7);
    assert_eq!(settled.status, GoalStatus::BudgetExhausted);
    let wire = serde_json::to_value(&settled).unwrap();
    assert_eq!(wire["budget"], json!({"maxTurns":null,"maxTokens":5}));
    assert!(wire.get("pendingBudget").is_none());
}

#[test]
fn goals_refinement_stop_immediately_fences_reports() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "live");
    let requested = control_goal(&db, &g, "pause", None).unwrap();
    let stopped = control_goal(&db, &requested, "stop", None).unwrap();
    assert!(!stopped.pause_requested);
    assert_eq!(stopped.active_turn_id, g.active_turn_id);
    assert_eq!(stopped.status, GoalStatus::Paused);
    assert!(report_goal(&db, &stopped, "live", "active", json!([])).is_err());
    assert_eq!(settle(&db, &stopped, "live", 7).token_usage, 7);
}

#[test]
fn goals_refinement_budget_changes_do_not_resume_stopped_states() {
    for status in ["paused", "blocked", "budget_exhausted"] {
        let (_dir, db, session) = fixture();
        let g = start(
            &db,
            decode(json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":1}})),
        )
        .unwrap();
        let g = claim(&db, &g, "first");
        let g = if status == "blocked" {
            report_goal(&db, &g, "first", "blocked", json!([])).unwrap()
        } else if status == "paused" {
            control_goal(&db, &g, "pause", None).unwrap()
        } else {
            g
        };
        let stopped = settle(&db, &g, "first", 3);
        assert_eq!(stopped.status.as_str(), status);
        let updated =
            control_goal(&db, &stopped, "budget", Some(json!({"maxTurns":null}))).unwrap();
        assert_eq!(updated.status, stopped.status);
        assert_eq!(updated.stop_reason, stopped.stop_reason);
        assert_eq!((updated.rounds_started, updated.token_usage), (1, 3));
        assert!(updated.pending_budget.is_none() && updated.active_since_ms.is_none());
        let (_, claimed) = claim_turn(
            &db,
            decode(json!({"sessionId":session,"goalId":g.id,
            "expectedRevision":updated.revision,"turnId":"not-authorized"})),
        )
        .unwrap();
        assert!(!claimed);
        let resumed = control_goal(&db, &updated, "resume", None).unwrap();
        assert_eq!(claim(&db, &resumed, "explicit-resume").rounds_started, 2);
    }
}

#[test]
fn goals_refinement_pending_budget_replaces_old_cap_before_exhaustion() {
    for replacement in [json!({"maxTurns":2}), json!({"maxTurns":null})] {
        let (_dir, db, session) = fixture();
        let g = start(
            &db,
            decode(json!({"sessionId":session,"objective":"ship",
            "budget":{"maxTurns":1,"maxTokens":2}})),
        )
        .unwrap();
        let g = claim(&db, &g, "first");
        let staged = control_goal(&db, &g, "budget", Some(replacement.clone())).unwrap();
        assert_eq!(staged.budget.max_turns, Some(1));
        let applied = settle(&db, &staged, "first", 20);
        assert_eq!(applied.status, GoalStatus::Active);
        assert_eq!(
            serde_json::to_value(&applied).unwrap()["budget"],
            replacement
        );
        assert!(applied.pending_budget.is_none());
        let next = claim(&db, &applied, "next");
        let next = settle(&db, &next, "next", 0);
        assert_eq!(
            next.status,
            if replacement["maxTurns"].is_null() {
                GoalStatus::Active
            } else {
                GoalStatus::BudgetExhausted
            }
        );
    }
}

#[test]
fn goals_refinement_exhausted_new_idle_cap_only_fences_next_admission() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "first");
    let g = settle(&db, &g, "first", 3);
    let updated = control_goal(&db, &g, "budget", Some(json!({"maxTurns":1}))).unwrap();
    assert_eq!(updated.status, GoalStatus::Active);
    assert!(updated.pending_budget.is_none());
    let (fenced, claimed) = claim_turn(
        &db,
        decode(json!({"sessionId":session,"goalId":g.id,
        "expectedRevision":updated.revision,"turnId":"over-cap"})),
    )
    .unwrap();
    assert!(!claimed);
    assert_eq!(fenced.status, GoalStatus::BudgetExhausted);
    assert_eq!(fenced.rounds_started, 1);
}

#[test]
fn goals_refinement_latest_edit_and_budget_win_revision_cas_without_resetting_time() {
    let (_dir, db, session) = fixture();
    let g = clock::at(1_000, || start_default(&db, &session));
    let g = clock::at(2_000, || claim(&db, &g, "first"));
    let g = clock::at(2_100, || {
        report_goal(
            &db,
            &g,
            "first",
            "active",
            json!([{"criterion":"ship","outcome":"unverified","evidence":"old"}]),
        )
        .unwrap()
    });
    let staged = clock::at(2_200, || {
        control_goal(&db, &g, "budget", Some(json!({"maxTurns":2}))).unwrap()
    });
    let edited = clock::at(2_300, || edit(&db, &staged, "scope one"));
    let latest = clock::at(2_400, || edit(&db, &edited, "scope two"));
    assert_eq!(
        (latest.elapsed_ms, latest.active_since_ms),
        (1_400, Some(2_400))
    );
    assert_eq!(latest.active_turn_id, g.active_turn_id);
    assert_eq!((latest.rounds_started, latest.token_usage), (1, 0));
    assert_eq!(latest.budget.max_turns, Some(20));
    assert_eq!(latest.pending_budget.as_ref().unwrap().max_turns, Some(2));
    assert!(
        latest.outcomes.is_empty() && latest.progress_summary.is_empty() && latest.audit.is_none()
    );
    assert_eq!(
        control(
            &db,
            decode(json!({"sessionId":session,"goalId":g.id,
        "expectedRevision":edited.revision,"action":"edit","objective":"stale"}))
        )
        .unwrap_err()
        .to_string(),
        "GOAL_STALE_REVISION"
    );
    assert_eq!(
        control_goal(&db, &edited, "budget", Some(json!({"maxTurns":1})))
            .unwrap_err()
            .to_string(),
        "GOAL_STALE_REVISION"
    );
    let latest = control_goal(&db, &latest, "budget", Some(json!({"maxTurns":null}))).unwrap();
    let applied = settle(&db, &latest, "first", 1);
    assert_eq!(applied.objective, "scope two");
    assert!(applied.budget.max_turns.is_none() && applied.pending_budget.is_none());
}
