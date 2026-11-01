use super::*;

fn audit(g: &SessionGoal) -> Value {
    json!({"version":1,"objective":g.objective,"items":[
        {"requirement":"ship verified result","outcome":"met","evidence":"test output and reviewed delivery"}
    ],"remainingWork":[]})
}
fn completed_input(g: &SessionGoal) -> Value {
    json!({"sessionId":g.session_id,"goalId":g.id,"turnId":"audit-turn",
        "progressSummary":"done","status":"completed",
        "outcomes":[{"criterion":"ship","outcome":"met","evidence":"test output"}]})
}
#[test]
fn goals_approved_missing_audit_never_completes_or_mutates() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "audit-turn");
    let before = serde_json::to_value(&g).unwrap();
    let error = report(&db, decode(completed_input(&g))).unwrap_err();
    assert_eq!(error.to_string(), "GOAL_COMPLETION_UNVERIFIED");
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        before
    );
}
#[test]
fn goals_approved_four_budget_combinations_count_beyond_twenty() {
    for turns in [json!(25), Value::Null] {
        for tokens in [None, Some(24)] {
            let (_dir, db, session) = fixture();
            let mut budget = json!({"maxTurns":turns});
            if let Some(tokens) = tokens {
                budget["maxTokens"] = json!(tokens);
            }
            let mut g = start(
                &db,
                decode(json!({"sessionId":session,"objective":"ship","budget":budget})),
            )
            .unwrap();
            let count = if tokens.is_some() {
                24
            } else if turns.is_null() {
                30
            } else {
                25
            };
            for i in 0..count {
                let turn = format!("turn-{i}");
                g = claim(&db, &g, &turn);
                g = settle(&db, &g, &turn, 1);
            }
            assert_eq!(g.rounds_started, count);
            assert_eq!(g.token_usage, count);
            assert_eq!(
                g.status,
                if tokens.is_some() || !turns.is_null() {
                    GoalStatus::BudgetExhausted
                } else {
                    GoalStatus::Active
                }
            );
        }
    }
}
#[test]
fn goals_approved_default_settings_are_snapshotted_only_for_new_goals() {
    let (_dir, db, session) = fixture();
    let old = start_default(&db, &session);
    db.set_setting(
        "app",
        &json!({"defaultGoalBudget":{"maxTurns":null,"maxTokens":500}}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        serde_json::to_value(&old).unwrap()
    );
    control_goal(&db, &old, "cancel", None).unwrap();
    let new = start_default(&db, &session);
    assert_eq!(
        serde_json::to_value(&new).unwrap()["budget"],
        json!({"maxTurns":null,"maxTokens":500})
    );
    assert_eq!(new.rounds_started, 0);
    assert!(new.active_turn_id.is_none());
}

#[test]
fn goals_approved_audit_validation_is_correctable_and_persisted_atomically() {
    let (dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "audit-turn");
    let good = audit(&g);
    let mut invalid = vec![];
    for (field, value) in [
        ("objective", json!("ship ")),
        ("items", json!([])),
        ("remainingWork", json!(["finish review"])),
    ] {
        let mut a = good.clone();
        a[field] = value;
        invalid.push(a);
    }
    for (field, value) in [
        ("requirement", json!(" ")),
        ("requirement", json!("x".repeat(100001))),
        ("outcome", json!("unmet")),
        ("outcome", json!("unverified")),
        ("evidence", json!(" ")),
    ] {
        let mut a = good.clone();
        a["items"][0][field] = value;
        invalid.push(a);
    }
    let mut duplicate = good.clone();
    duplicate["items"] = json!([good["items"][0], good["items"][0]]);
    invalid.push(duplicate);
    let mut duplicate = good.clone();
    let mut padded = good["items"][0].clone();
    padded["requirement"] = json!(" ship verified result ");
    duplicate["items"] = json!([good["items"][0], padded]);
    invalid.push(duplicate);
    let mut many = good.clone();
    many["items"] = json!(vec![good["items"][0].clone(); 101]);
    invalid.push(many);
    let mut blank = good.clone();
    blank["remainingWork"] = json!([" "]);
    invalid.push(blank);
    let before = serde_json::to_value(&g).unwrap();
    for a in invalid {
        let mut input = completed_input(&g);
        input["audit"] = a;
        assert!(report(&db, decode(input)).is_err());
        assert_eq!(
            serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
            before
        );
    }
    let mut input = completed_input(&g);
    input["audit"] = good.clone();
    db.conn().execute_batch("CREATE TEMP TRIGGER reject_report BEFORE UPDATE ON session_goals BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(report(&db, decode(input.clone())).is_err());
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        before
    );
    db.conn()
        .execute_batch("DROP TRIGGER reject_report;")
        .unwrap();
    let completed = report(&db, decode(input)).unwrap();
    assert_eq!(completed.status, GoalStatus::Completed);
    assert_eq!(serde_json::to_value(&completed).unwrap()["audit"], good);
    let done = settle(&db, &completed, "audit-turn", 21);
    assert_eq!(done.status, GoalStatus::Completed);
    assert_eq!(done.token_usage, 21);
    let (_,claimed)=claim_turn(&db,decode(json!({"sessionId":session,"goalId":g.id,"expectedRevision":done.revision,"turnId":"extra"}))).unwrap();
    assert!(!claimed);
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap()["audit"],
        good
    );
}
#[test]
fn goals_approved_incomplete_audit_is_progress_only_and_new_report_clears_it() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "audit-turn");
    let mut a = audit(&g);
    a["items"][0]["outcome"] = json!("unverified");
    a["items"][0]["evidence"] = json!("");
    a["remainingWork"] = json!(["run full verification"]);
    let mut input = completed_input(&g);
    input["status"] = json!("active");
    input["audit"] = a.clone();
    let active = report(&db, decode(input.clone())).unwrap();
    assert_eq!(serde_json::to_value(active).unwrap()["audit"], a);
    input.as_object_mut().unwrap().remove("audit");
    let cleared = report(&db, decode(input.clone())).unwrap();
    assert!(serde_json::to_value(cleared)
        .unwrap()
        .get("audit")
        .is_none());
    input["status"] = json!("blocked");
    input["audit"] = a;
    assert_eq!(
        report(&db, decode(input)).unwrap().status,
        GoalStatus::Blocked
    );
}

#[test]
fn goals_approved_valid_audit_cannot_bypass_criteria_or_stop_fences() {
    for action in ["stop", "cancel", "mode"] {
        let (_dir, db, session) = fixture();
        let g = claim(&db, &start_default(&db, &session), "audit-turn");
        let mut input = completed_input(&g);
        input["audit"] = audit(&g);
        let mut missing = input.clone();
        missing["outcomes"] = json!([]);
        assert_eq!(
            report(&db, decode(missing)).unwrap_err().to_string(),
            "GOAL_COMPLETION_UNVERIFIED"
        );
        let mut missing = input.clone();
        missing["outcomes"][0]["evidence"] = json!(" ");
        assert!(report(&db, decode(missing)).is_err());
        if action == "mode" {
            crate::sessions::configure_session_with_thinking(
                &db, &session, "agent", None, None, None, None,
            )
            .unwrap();
        } else {
            control_goal(&db, &g, action, None).unwrap();
        }
        let before = serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap();
        if action == "mode" {
            assert_eq!(
                report(&db, decode(input)).unwrap().status,
                GoalStatus::Completed
            );
        } else {
            assert!(report(&db, decode(input)).is_err());
            assert_eq!(
                serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
                before
            );
        }
    }
}
#[test]
fn goals_approved_required_budget_fields_and_malformed_saved_defaults_fail_closed() {
    let (_dir, db, session) = fixture();
    for budget in [
        json!({}),
        json!({"maxTokens":3}),
        Value::Null,
        json!({"maxTurns":null,"maxTokens":null}),
    ] {
        assert!(serde_json::from_value::<StartParams>(
            json!({"sessionId":session,"objective":"ship","budget":budget})
        )
        .is_err());
        db.kv_set("app", "app", &json!({"defaultGoalBudget":budget}))
            .unwrap();
        assert_eq!(
            start(&db, decode(json!({"sessionId":session,"objective":"ship"})))
                .unwrap_err()
                .to_string(),
            "GOAL_INVALID_BUDGET"
        );
        assert!(get(&db, &session).unwrap().is_none());
    }
}
#[test]
fn goals_approved_unlimited_counters_fail_closed_without_claim_or_usage_corruption() {
    let (_dir, db, session) = fixture();
    let g = start(
        &db,
        decode(json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":null}})),
    )
    .unwrap();
    db.conn()
        .execute(
            "UPDATE session_goals SET rounds_started=?1 WHERE id=?2",
            params![MAX_SAFE_INTEGER, g.id],
        )
        .unwrap();
    let before = serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap();
    assert_eq!(claim_turn(&db,decode(json!({"sessionId":session,"goalId":g.id,"expectedRevision":g.revision,"turnId":"overflow"}))).unwrap_err().to_string(),"GOAL_COUNTER_OVERFLOW");
    assert_eq!(
        db.conn()
            .query_row("SELECT COUNT(*) FROM goal_turns", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        before
    );
    db.conn()
        .execute(
            "UPDATE session_goals SET rounds_started=0 WHERE id=?1",
            [&g.id],
        )
        .unwrap();
    let g = claim(&db, &g, "last");
    db.conn()
        .execute(
            "UPDATE session_goals SET token_usage=?1 WHERE id=?2",
            params![MAX_SAFE_INTEGER, g.id],
        )
        .unwrap();
    let before = serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap();
    assert_eq!(
        settle_turn(
            &db,
            decode(json!({"sessionId":session,"goalId":g.id,"turnId":"last","tokens":1}))
        )
        .unwrap_err()
        .to_string(),
        "GOAL_COUNTER_OVERFLOW"
    );
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        before
    );
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT settled FROM goal_turns WHERE turn_id='last'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn goals_approved_v28_upgrade_keeps_terminal_reports_and_pauses_unfinished() {
    for status in ["completed", "cancelled", "active"] {
        let (dir, db, session) = fixture();
        let old = start(&db, decode(json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":7,"maxTokens":99}}))).unwrap();
        let g = claim(&db, &old, "old-turn");
        let outcomes = json!([{"criterion":"ship","outcome":"met","evidence":"legacy evidence"}]);
        db.conn().execute("UPDATE session_goals SET status=?1,progress_summary='legacy',outcomes_json=?2 WHERE id=?3",params![status,outcomes.to_string(),g.id]).unwrap();
        let has_audit = db
            .conn()
            .prepare("PRAGMA table_info(session_goals)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .any(|name| name == "audit_json");
        if has_audit {
            db.conn()
                .execute_batch("ALTER TABLE session_goals DROP COLUMN audit_json;")
                .unwrap();
        }
        db.conn().execute_batch("DROP TRIGGER IF EXISTS session_goals_safe_insert; DROP TRIGGER IF EXISTS session_goals_safe_update;").unwrap();
        db.conn().pragma_update(None, "user_version", 28).unwrap();
        drop(db);
        let path = dir.path().join("test.sqlite");
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.conn()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            crate::db::SCHEMA_VERSION
        );
        let read = serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap();
        assert_eq!(
            read["status"],
            if status == "active" { "paused" } else { status }
        );
        assert_eq!(read["budget"], json!({"maxTurns":7,"maxTokens":99}));
        assert_eq!(read["outcomes"], outcomes);
        assert_eq!(read["progressSummary"], "legacy");
        assert!(read.get("audit").is_none());
        assert!(read.get("activeTurnId").is_none());
        let backup = crate::db::migration_backup_path(&path, 28);
        assert!(backup.exists());
        let old = Connection::open(backup).unwrap();
        assert_eq!(
            old.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            28
        );
        assert_eq!(
            old.query_row(
                "SELECT status FROM session_goals WHERE id=?1",
                [&g.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            status
        );
        drop(db);
        let raw = Connection::open(&path).unwrap();
        raw.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION + 1)
            .unwrap();
        drop(raw);
        assert!(Database::open(&path)
            .err()
            .unwrap()
            .to_string()
            .contains("newer than supported"));
    }
}

#[test]
fn goals_approved_revision_overflow_fences_raw_lifecycle_updates() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "audit-turn");
    db.conn()
        .execute(
            "UPDATE session_goals SET revision=?1 WHERE id=?2",
            params![MAX_SAFE_INTEGER, g.id],
        )
        .unwrap();
    let g = get(&db, &session).unwrap().unwrap();
    let before = serde_json::to_value(&g).unwrap();
    assert_eq!(
        control_goal(&db, &g, "pause", None)
            .unwrap_err()
            .to_string(),
        "GOAL_COUNTER_OVERFLOW"
    );
    assert_eq!(
        recover(&db).unwrap_err().to_string(),
        "GOAL_COUNTER_OVERFLOW"
    );
    crate::sessions::configure_session_with_thinking(&db, &session, "plan", None, None, None, None)
        .unwrap();
    assert_eq!(session_mode(db.conn(), &session).unwrap(), "plan");
    assert_eq!(
        serde_json::to_value(get(&db, &session).unwrap().unwrap()).unwrap(),
        before
    );
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT settled FROM goal_turns WHERE turn_id='audit-turn'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[test]
fn goals_approved_defaults_survive_reopen_and_explicit_budget_wins() {
    for budget in [json!({"maxTurns":6}), json!({"maxTurns":null})] {
        let (dir, db, session) = fixture();
        db.set_setting("app", &json!({"defaultGoalBudget":budget,"theme":"light"}))
            .unwrap();
        drop(db);
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        assert_eq!(
            db.get_setting("app").unwrap().unwrap(),
            json!({"defaultGoalBudget":budget,"theme":"light"})
        );
        let g=start(&db,decode(json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":3,"maxTokens":5}}))).unwrap();
        assert_eq!(
            serde_json::to_value(&g).unwrap()["budget"],
            json!({"maxTurns":3,"maxTokens":5})
        );
        let paused = control_goal(&db, &g, "pause", None).unwrap();
        let resumed = control_goal(&db, &paused, "resume", None).unwrap();
        assert_eq!(
            serde_json::to_value(&resumed).unwrap()["budget"],
            json!({"maxTurns":3,"maxTokens":5})
        );
        assert_eq!(resumed.rounds_started, 0);
        assert!(resumed.active_turn_id.is_none());
    }
}
#[test]
fn goals_approved_audit_shape_and_unknown_persisted_versions_are_rejected() {
    let (_dir, db, session) = fixture();
    let g = claim(&db, &start_default(&db, &session), "audit-turn");
    let good = audit(&g);
    for field in ["version", "objective", "items", "remainingWork"] {
        let mut input = completed_input(&g);
        input["audit"] = good.clone();
        input["audit"].as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<ReportParams>(input).is_err());
    }
    for field in ["requirement", "outcome", "evidence"] {
        let mut input = completed_input(&g);
        input["audit"] = good.clone();
        input["audit"]["items"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(serde_json::from_value::<ReportParams>(input).is_err());
    }
    let mut unknown = good;
    unknown["version"] = json!(2);
    let mut input = completed_input(&g);
    input["audit"] = unknown.clone();
    assert!(serde_json::from_value::<ReportParams>(input).is_err());
    db.conn()
        .execute(
            "UPDATE session_goals SET audit_json=?1 WHERE id=?2",
            params![unknown.to_string(), g.id],
        )
        .unwrap();
    assert!(get(&db, &session).is_err());
}

#[test]
fn goals_approved_explicit_unlimited_resume_keeps_accounting_and_ignores_new_defaults() {
    let (_dir, db, session) = fixture();
    let g = start(
        &db,
        decode(
            json!({"sessionId":session,"objective":"ship","budget":{"maxTurns":1,"maxTokens":2}}),
        ),
    )
    .unwrap();
    let g = claim(&db, &g, "initial");
    let exhausted = settle(&db, &g, "initial", 2);
    assert_eq!(exhausted.status, GoalStatus::BudgetExhausted);
    db.set_setting("app", &json!({"defaultGoalBudget":{"maxTurns":100}}))
        .unwrap();
    assert!(control_goal(&db, &exhausted, "resume", None).is_err());
    assert!(control_goal(
        &db,
        &exhausted,
        "resume",
        Some(json!({"maxTurns":null,"maxTokens":2}))
    )
    .is_err());
    let mut g = control_goal(&db, &exhausted, "resume", Some(json!({"maxTurns":null}))).unwrap();
    assert_eq!(g.rounds_started, 1);
    assert_eq!(g.token_usage, 2);
    assert!(g.active_turn_id.is_none());
    for n in 1..25 {
        let turn = format!("resumed-{n}");
        g = claim(&db, &g, &turn);
        g = settle(&db, &g, &turn, 1);
    }
    assert_eq!(g.rounds_started, 25);
    assert_eq!(g.token_usage, 26);
    assert_eq!(g.status, GoalStatus::Active);
}
