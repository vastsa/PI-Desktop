//! Completion reports are model evidence, never a replacement for Host gates.

use serde_json::{json, Value};

use super::model::*;
use super::repository;
use super::snapshot_tests::goal_snapshot;
use super::tests::{
    claim, configure, control_run, fixture, mode_row, session, settle, start_run, Fixture,
};
use super::*;
use crate::db::Database;

const ARTIFACT: &str = "# Objective\nship it\n# Acceptance criteria\nworks\n# Evidence\ntests\n";

fn completed() -> Value {
    json!({"status":"completed", "outcomes":[{"criterion":"works", "outcome":"met", "evidence":"tests passed"}], "remainingWork":[]})
}

fn blocked() -> Value {
    json!({"status":"blocked", "outcomes":[{"criterion":"works", "outcome":"unverified", "evidence":"service unavailable"}], "remainingWork":["run integration tests"], "blockerReason":"service unavailable"})
}

fn setup() -> (Fixture, ModeRun) {
    let fx = fixture();
    let sid = session(&fx, "agent");
    configure(&fx.db, &sid, "goal", Some(&goal_snapshot())).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    (fx, run)
}

fn params(run: &ModeRun, report: Value) -> Value {
    json!({"sessionId":run.session_id, "runId":run.id, "turnId":"t1", "input":run.input,
        "report":report, "artifacts":{"goal":ARTIFACT}})
}

fn submit(fx: &Fixture, value: Value) -> anyhow::Result<StageOutcome> {
    complete_stage(&fx.db, &fx.workspace, serde_json::from_value(value)?)
}

fn gate_count(db: &Database, run: &ModeRun) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM mode_gate_results WHERE run_id=?1",
            [&run.id],
            |row| row.get(0),
        )
        .unwrap()
}

fn invalid_reports() -> Vec<Value> {
    let mut cases = vec![Value::Null, json!({}), json!("completed")];
    let base = completed();
    for (key, value) in [
        ("status", json!("success")),
        ("extra", json!(true)),
        ("outcomes", json!([])),
        ("outcomes", json!(vec![base["outcomes"][0].clone(); 65])),
        (
            "outcomes",
            json!([base["outcomes"][0].clone(), {"criterion":" works ", "outcome":"met", "evidence":"ok"}]),
        ),
        ("remainingWork", json!(["later"])),
        ("blockerReason", json!("not complete")),
        ("blockerReason", Value::Null),
    ] {
        let mut report = base.clone();
        report[key] = value;
        cases.push(report);
    }
    let mut missing = base.clone();
    missing.as_object_mut().unwrap().remove("remainingWork");
    cases.push(missing);
    for (key, value) in [
        ("criterion", json!(" \n ")),
        ("criterion", json!("界".repeat(1366))),
        ("evidence", json!("\t")),
        ("evidence", json!("x".repeat(16385))),
        ("outcome", json!("unmet")),
        ("outcome", json!("unverified")),
        ("outcome", json!("passed")),
        ("extra", json!(1)),
    ] {
        let mut report = base.clone();
        report["outcomes"][0][key] = value;
        cases.push(report);
    }
    for (key, value) in [
        ("blockerReason", json!("")),
        ("blockerReason", json!(" \n")),
        ("blockerReason", json!("x".repeat(16385))),
        ("remainingWork", json!([" "])),
        ("remainingWork", json!(["界".repeat(1366)])),
        ("remainingWork", json!(vec!["work"; 65])),
    ] {
        let mut report = blocked();
        report[key] = value;
        cases.push(report);
    }
    let mut missing = blocked();
    missing.as_object_mut().unwrap().remove("blockerReason");
    cases.push(missing);
    let mut no_work = blocked();
    no_work["outcomes"][0]["outcome"] = json!("met");
    no_work["remainingWork"] = json!([]);
    cases.push(no_work);
    let mut large = base.clone();
    large["outcomes"] = json!((0..64).map(|i| json!({"criterion":format!("criterion {i}"), "outcome":"met", "evidence":"x".repeat(4096)})).collect::<Vec<_>>());
    assert!(serde_json::to_vec(&large).unwrap().len() > 262144);
    cases.push(large);
    cases
}

#[test]
fn completion_report_validation_is_independent_and_precedes_artifact_writes() {
    let (fx, run) = setup();
    let path = fx.workspace.join(&run.artifact_paths["goal"]);
    for (i, report) in invalid_reports().into_iter().enumerate() {
        let error = submit(&fx, params(&run, report)).unwrap_err().to_string();
        assert!(
            error.starts_with("MODE_INVALID_ARGUMENT"),
            "case {i}: {error}"
        );
        assert!(!path.exists(), "case {i} wrote an artifact");
        assert_eq!(
            repository::owned(fx.db.conn(), &run.session_id, &run.id).unwrap(),
            run
        );
        assert_eq!(gate_count(&fx.db, &run), 0);
    }
}

#[test]
fn completion_report_completed_finishes_only_after_existing_gates_and_round_trips() {
    let (fx, run) = setup();
    assert!(run.wire().get("completionReport").is_none());
    let mut no_artifact = params(&run, completed());
    no_artifact.as_object_mut().unwrap().remove("artifacts");
    let failed = submit(&fx, no_artifact).unwrap();
    assert!(matches!(failed.status, StageStatus::Failed { .. }));
    assert_eq!(failed.run.state, RunState::Running);
    assert_eq!(failed.run.wire()["completionReport"], completed());
    let finished = submit(&fx, params(&failed.run, completed())).unwrap();
    assert_eq!(finished.status, StageStatus::Finished);
    assert_eq!(finished.run.wire()["completionReport"], completed());
    assert!(finished.run.active_since_ms.is_none());
    assert_eq!(mode_row(&fx.db, &run.session_id), ("agent".into(), None));
    let settled = settle(&fx, &finished.run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run);
    assert_eq!(
        (settled.run.rounds_completed, settled.run.tokens_used),
        (1, 100)
    );
    let db = Database::open(&fx.db.data_dir().join("pi.sqlite")).unwrap();
    assert_eq!(
        repository::owned(db.conn(), &run.session_id, &run.id).unwrap(),
        settled.run
    );
    let stored: String = db
        .conn()
        .query_row(
            "SELECT completion_report_json FROM mode_runs WHERE id=?1",
            [&run.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), completed());
}

#[test]
fn completion_report_blocked_waits_settles_once_reloads_and_requires_user_resume() {
    let (fx, mut run) = setup();
    // A blocked report cancels even a previously pending command, without evaluating it.
    run.pending_gate = Some(0);
    repository::save(fx.db.conn(), &mut run).unwrap();
    let outcome = submit(&fx, params(&run, blocked())).unwrap();
    assert_eq!(
        outcome.status,
        StageStatus::Blocked {
            message: "service unavailable".into()
        }
    );
    assert_eq!(outcome.run.state, RunState::Waiting);
    assert_eq!(outcome.run.wire()["waitReason"], "blocked");
    assert_eq!(outcome.run.wire()["completionReport"], blocked());
    assert_eq!(
        outcome.run.last_error.as_deref(),
        Some("service unavailable")
    );
    assert!(outcome.run.pending_gate.is_none() && outcome.run.finished_at.is_none());
    assert_eq!(outcome.run.active_turn_id.as_deref(), Some("t1"));
    assert!(outcome.run.active_since_ms.is_none());
    assert_eq!(
        (outcome.run.max_turns, outcome.run.max_tokens),
        (run.max_turns, run.max_tokens)
    );
    assert_eq!(mode_row(&fx.db, &run.session_id).0, "goal");
    assert_eq!(gate_count(&fx.db, &run), 0);
    let settled = settle(&fx, &outcome.run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run && settled.changed);
    assert!(settled.run.active_turn_id.is_none());
    assert_eq!(
        (settled.run.rounds_completed, settled.run.tokens_used),
        (1, 100)
    );
    let duplicate = settle(&fx, &settled.run, "t1", TurnOutcome::Completed);
    assert!(!duplicate.changed && !duplicate.continue_run);
    assert_eq!(duplicate.run, settled.run);
    assert!(!claim(&fx, &settled.run, "host", Origin::Host).claimed);
    assert!(!claim(&fx, &settled.run, "approval", Origin::Approval).claimed);
    assert!(!claim(&fx, &settled.run, "user", Origin::User).claimed);
    let db = Database::open(&fx.db.data_dir().join("pi.sqlite")).unwrap();
    recover(&db).unwrap();
    assert_eq!(
        open_run(&db, &run.session_id).unwrap().unwrap(),
        settled.run
    );
    let resumed = control_run(&fx, &settled.run, ControlAction::Resume).unwrap();
    assert!(resumed.continue_run);
    assert_eq!(resumed.run.state, RunState::Running);
    assert!(claim(&fx, &resumed.run, "next", Origin::Host).claimed);
}

#[test]
fn completion_report_blocked_survives_recovery_before_settlement_and_error_settlement() {
    for outcome in [
        TurnOutcome::Completed,
        TurnOutcome::Error,
        TurnOutcome::Aborted,
    ] {
        let (fx, run) = setup();
        let blocked = submit(&fx, params(&run, blocked())).unwrap().run;
        let settled = settle(&fx, &blocked, "t1", outcome);
        assert!(!settled.continue_run);
        assert_eq!(settled.run.wire()["waitReason"], "blocked");
        assert_eq!(settled.run.last_error, blocked.last_error);
        assert!(settled.run.active_turn_id.is_none());
    }
    let (fx, run) = setup();
    let blocked = submit(&fx, params(&run, blocked())).unwrap().run;
    assert_eq!(recover(&fx.db).unwrap(), 1);
    let recovered = open_run(&fx.db, &run.session_id).unwrap().unwrap();
    assert_eq!(recovered.wire()["waitReason"], "blocked");
    assert_eq!(
        recovered.wire()["completionReport"],
        blocked.wire()["completionReport"]
    );
    assert!(recovered.active_turn_id.is_none());
    assert_eq!(recovered.elapsed_ms, blocked.elapsed_ms);
    assert_eq!(recover(&fx.db).unwrap(), 0);
    let late = settle(&fx, &recovered, "t1", TurnOutcome::Completed);
    assert!(!late.continue_run);
    assert_eq!((late.run.rounds_completed, late.run.tokens_used), (1, 100));
    assert_eq!(late.run.wire()["waitReason"], "blocked");
    assert!(!settle(&fx, &late.run, "t1", TurnOutcome::Completed).changed);
}

#[test]
fn completion_report_cannot_override_control_claim_session_or_frozen_input() {
    for report in [completed(), blocked()] {
        for action in [
            ControlAction::Pause,
            ControlAction::Stop,
            ControlAction::Remove,
        ] {
            let (fx, run) = setup();
            let controlled = control_run(&fx, &run, action).unwrap().run;
            assert_eq!(
                submit(&fx, params(&run, report.clone()))
                    .unwrap_err()
                    .to_string(),
                "MODE_CLAIM_MISMATCH"
            );
            assert_eq!(
                repository::owned(fx.db.conn(), &run.session_id, &run.id).unwrap(),
                controlled
            );
        }
        for field in [
            "turnId",
            "sessionId",
            "input",
            "missing-input",
            "unclaimed",
            "deleted",
        ] {
            let (fx, run) = setup();
            let mut p = params(&run, report.clone());
            let code = match field {
                "turnId" => {
                    p["turnId"] = json!("stale");
                    "MODE_CLAIM_MISMATCH"
                }
                "sessionId" => {
                    p["sessionId"] = json!(session(&fx, "agent"));
                    "MODE_RUN_NOT_FOUND"
                }
                "input" => {
                    update(
                        &fx.db,
                        UpdateParams {
                            session_id: run.session_id.clone(),
                            run_id: run.id.clone(),
                            expected_revision: run.revision,
                            input: Some("new objective".into()),
                            budget: None,
                        },
                    )
                    .unwrap();
                    "MODE_INPUT_CHANGED"
                }
                "missing-input" => {
                    p.as_object_mut().unwrap().remove("input");
                    "MODE_INPUT_CHANGED"
                }
                "unclaimed" => {
                    settle(&fx, &run, "t1", TurnOutcome::Completed);
                    "MODE_CLAIM_MISMATCH"
                }
                "deleted" => {
                    fx.db
                        .conn()
                        .execute(
                            "UPDATE sessions SET deleted_at=1 WHERE id=?1",
                            [&run.session_id],
                        )
                        .unwrap();
                    "MODE_SESSION_NOT_FOUND"
                }
                _ => unreachable!(),
            };
            let before = repository::owned(fx.db.conn(), &run.session_id, &run.id).unwrap();
            assert_eq!(submit(&fx, p).unwrap_err().to_string(), code, "{field}");
            assert_eq!(
                repository::owned(fx.db.conn(), &run.session_id, &run.id).unwrap(),
                before
            );
            assert!(!fx.workspace.join(&run.artifact_paths["goal"]).exists());
        }
    }
}

#[test]
fn completion_report_preserves_artifact_sandbox_and_atomic_gate_persistence() {
    let (fx, run) = setup();
    for report in [completed(), blocked()] {
        let mut p = params(&run, report);
        p["artifacts"] = json!({"undeclared":"not allowed"});
        assert!(submit(&fx, p).is_err());
        assert_eq!(
            repository::owned(fx.db.conn(), &run.session_id, &run.id).unwrap(),
            run
        );
    }
    fx.db.conn().execute_batch("CREATE TRIGGER reject_report BEFORE UPDATE ON mode_runs BEGIN SELECT RAISE(ABORT, 'write rejected'); END;").unwrap();
    assert!(submit(&fx, params(&run, completed())).is_err());
    assert_eq!(gate_count(&fx.db, &run), 0);
    assert_eq!(
        repository::owned(fx.db.conn(), &run.session_id, &run.id).unwrap(),
        run
    );
}

#[test]
fn completion_report_accepts_byte_limits_and_each_valid_blocked_shape() {
    for met_with_work in [false, true] {
        let (fx, run) = setup();
        let mut report = blocked();
        report["outcomes"][0]["criterion"] = json!("界".repeat(1365) + "a");
        report["outcomes"][0]["evidence"] = json!("x".repeat(16384));
        report["blockerReason"] = json!("x".repeat(16384));
        report["remainingWork"] = if met_with_work {
            json!(["x".repeat(4096)])
        } else {
            json!([])
        };
        if met_with_work {
            report["outcomes"][0]["outcome"] = json!("met");
        }
        let result = submit(&fx, params(&run, report.clone())).unwrap();
        assert_eq!(result.run.wire()["completionReport"], report);
        assert!(result.run.last_error.unwrap().len() <= 16384);
    }
    let (fx, run) = setup();
    let mut report = completed();
    report["outcomes"] = json!((0..64)
        .map(|i| json!({"criterion":format!("c{i}"), "outcome":"met", "evidence":"ok"}))
        .collect::<Vec<_>>());
    assert_eq!(
        submit(&fx, params(&run, report)).unwrap().status,
        StageStatus::Finished
    );
}

#[test]
fn completion_report_serialized_size_limit_is_inclusive() {
    let (fx, run) = setup();
    let mut report = completed();
    report["outcomes"] = json!((0..16).map(|i| json!({"criterion":format!("c{i}"), "outcome":"met", "evidence":if i < 15 { "x".repeat(16384) } else { "x".into() }})).collect::<Vec<_>>());
    let size = serde_json::to_vec(&report).unwrap().len();
    report["outcomes"][15]["evidence"] = json!("x".repeat(262144 - size + 1));
    assert_eq!(serde_json::to_vec(&report).unwrap().len(), 262144);
    assert_eq!(
        submit(&fx, params(&run, report.clone())).unwrap().status,
        StageStatus::Finished
    );
    let evidence = report["outcomes"][15]["evidence"]
        .as_str()
        .unwrap()
        .to_string()
        + "x";
    report["outcomes"][15]["evidence"] = json!(evidence);
    assert!(submit(&fx, params(&run, report))
        .unwrap_err()
        .to_string()
        .starts_with("MODE_INVALID_ARGUMENT"));
}

#[test]
fn completion_report_completed_preserves_explicit_user_approval() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    let snapshot = super::tests::definition(
        "asks",
        "contract",
        json!([{"id":"review", "permission":"contract", "exit":[{"kind":"ask"}]}]),
    );
    configure(&fx.db, &sid, "asks", Some(&snapshot)).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    let mut p = params(&run, completed());
    p.as_object_mut().unwrap().remove("artifacts");
    let waiting = submit(&fx, p).unwrap();
    assert_eq!(waiting.status, StageStatus::AwaitingApproval);
    assert_eq!(waiting.run.wire()["completionReport"], completed());
    assert_eq!(waiting.run.wait_reason, Some(WaitReason::Approval));
    assert_eq!(mode_row(&fx.db, &sid).0, "asks");
    let settled = settle(&fx, &waiting.run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run);
    let approved = resolve(
        &fx.db,
        ResolveParams {
            session_id: sid.clone(),
            run_id: run.id,
            expected_revision: settled.run.revision,
            action: ResolveAction::Approve,
        },
    )
    .unwrap();
    assert_eq!(approved.run.state, RunState::Finished);
    assert_eq!(approved.run.wire()["completionReport"], completed());
    assert_eq!(mode_row(&fx.db, &sid).0, "agent");
}

#[test]
fn completion_report_blocked_cannot_reset_budget_or_replace_snapshot_authority() {
    let (fx, run) = setup();
    let limited = update(
        &fx.db,
        UpdateParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            expected_revision: run.revision,
            input: None,
            budget: Some(super::budget::RunBudget {
                max_turns: Some(1),
                max_tokens: Some(1_000),
            }),
        },
    )
    .unwrap()
    .run;
    let blocked = submit(&fx, params(&limited, blocked())).unwrap().run;
    let settled = settle(&fx, &blocked, "t1", TurnOutcome::Completed);
    assert_eq!(
        (settled.run.max_turns, settled.run.max_tokens),
        (Some(1), Some(1_000))
    );
    let resumed = control_run(&fx, &settled.run, ControlAction::Resume)
        .unwrap()
        .run;
    assert!(!claim(&fx, &resumed, "host", Origin::Host).claimed);
    assert_eq!(resumed.snapshot_hash, run.snapshot_hash);
    assert_eq!(
        tool_policy(&fx.db, &run.session_id).unwrap(),
        Some(ToolPolicy::Agent)
    );
    // Even a blocked result must refer to a real stage in the frozen snapshot.
    fx.db.conn().execute("UPDATE mode_runs SET stage_id='missing', active_turn_id='t1', active_origin='user' WHERE id=?1", [&run.id]).unwrap();
    assert!(submit(&fx, params(&resumed, self::blocked()))
        .unwrap_err()
        .to_string()
        .starts_with("MODE_SNAPSHOT_INVALID"));
}
