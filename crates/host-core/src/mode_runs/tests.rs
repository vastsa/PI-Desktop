//! Run engine: the user path through a staged mode, gate outcomes, budget,
//! control, CAS and recovery, plus the tool policy resolution order.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::model::*;
use super::snapshot_tests::goal_snapshot;
use super::*;
use crate::db::Database;
use crate::sessions;

pub(super) struct Fixture {
    _dir: tempfile::TempDir,
    pub db: Database,
    pub workspace: PathBuf,
}

pub(super) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    Fixture {
        _dir: dir,
        db,
        workspace,
    }
}

pub(super) fn session(fx: &Fixture, mode: &str) -> String {
    sessions::create_session(
        &fx.db,
        Some("Run".into()),
        Some(mode.into()),
        None,
        None,
        Some(fx.workspace.to_string_lossy().into_owned()),
    )
    .unwrap()
    .id
}

/// `session.configure` as the RPC adapter runs it.
pub(super) fn configure(
    db: &Database,
    id: &str,
    mode: &str,
    snapshot: Option<&Value>,
) -> anyhow::Result<Option<ModeRun>> {
    let prepared = prepare_session_mode(db, id, mode, snapshot)?;
    store_session_snapshot(db, &prepared)?;
    sessions::configure_session_with_mode_snapshot(
        db,
        id,
        mode,
        None,
        None,
        None,
        None,
        None,
        prepared.snapshot_hash(),
    )?;
    configure_session_mode(db, prepared)
}

pub(super) fn definition(id: &str, permission: &str, stages: Value) -> Value {
    json!({
        "version": 1, "id": id, "label": id, "description": "", "permission": permission,
        "prompt": "", "source": "user",
        "artifacts": [{ "id": "plan", "path": ".pi/flow/{{run.id}}.md", "requiredHeadings": ["Plan", "Risks"] }],
        "budget": { "maxTurns": 20, "maxTokens": null },
        "returnTo": "agent",
        "stages": stages
    })
}

fn require(retries: i64, goto: Option<&str>) -> Value {
    let mut on_fail = json!({ "retries": retries });
    if let Some(goto) = goto {
        on_fail["goto"] = json!(goto);
    }
    json!({ "kind": "require", "artifact": "plan", "onFail": on_fail })
}

fn flow() -> Value {
    definition(
        "flow",
        "contract",
        json!([
            { "id": "draft", "permission": "contract", "loop": false, "exit": [require(1, None)], "next": "work" },
            { "id": "work", "permission": "agent", "loop": true, "exit": [] }
        ]),
    )
}

pub(super) fn start_run(fx: &Fixture, sid: &str, turn: &str) -> ClaimResult {
    start(
        &fx.db,
        &fx.workspace,
        StartParams {
            session_id: sid.into(),
            input: "ship it".into(),
            turn_id: turn.into(),
        },
    )
    .unwrap()
}

pub(super) fn claim(fx: &Fixture, run: &ModeRun, turn: &str, origin: Origin) -> ClaimResult {
    claim_turn(
        &fx.db,
        ClaimParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            expected_revision: run.revision,
            turn_id: turn.into(),
            origin,
        },
    )
    .unwrap()
}

pub(super) fn settle(
    fx: &Fixture,
    run: &ModeRun,
    turn: &str,
    outcome: TurnOutcome,
) -> ContinueResult {
    settle_turn(
        &fx.db,
        SettleParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            turn_id: turn.into(),
            tokens: 100,
            outcome,
            error: Some("PROVIDER_FAILED".into()),
        },
    )
    .unwrap()
}

pub(super) fn complete(
    fx: &Fixture,
    run: &ModeRun,
    turn: &str,
    artifacts: Option<BTreeMap<String, String>>,
) -> anyhow::Result<StageOutcome> {
    complete_stage(
        &fx.db,
        &fx.workspace,
        CompleteStageParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            turn_id: turn.into(),
            summary: "done".into(),
            artifacts,
            input: None,
        },
    )
}

pub(super) fn control_run(
    fx: &Fixture,
    run: &ModeRun,
    action: ControlAction,
) -> anyhow::Result<ContinueResult> {
    control(
        &fx.db,
        ControlParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            expected_revision: run.revision,
            action,
        },
    )
}

fn plan_artifact(content: &str) -> Option<BTreeMap<String, String>> {
    Some(BTreeMap::from([("plan".to_string(), content.to_string())]))
}

fn policy(fx: &Fixture, sid: &str) -> Option<ToolPolicy> {
    tool_policy(&fx.db, sid).unwrap()
}

pub(super) fn mode_row(db: &Database, sid: &str) -> (String, Option<String>) {
    db.conn()
        .query_row(
            "SELECT mode, mode_snapshot_hash FROM sessions WHERE id = ?1",
            [sid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

#[test]
fn full_lifecycle_returns_the_session_to_its_return_mode() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    configure(&fx.db, &sid, "flow", Some(&flow())).unwrap();
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Contract));

    let started = start_run(&fx, &sid, "t1");
    assert!(started.claimed && started.entered_stage);
    assert_eq!(started.definition.as_ref().unwrap()["id"], "flow");
    let run = started.run;
    assert_eq!(run.stage_id, "draft");
    let wire = run.wire();
    assert_eq!(wire["activeOrigin"], "user");
    assert!(wire.get("waitReason").is_none() && wire.get("finishedAt").is_none());
    let artifact = run.artifact_paths["plan"].clone();
    assert_eq!(artifact, format!(".pi/flow/{}.md", run.id));
    // Drafting is read-only even though the mode's agent stage comes later.
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Contract));

    let missing = complete(&fx, &run, "t1", None).unwrap();
    match &missing.status {
        StageStatus::Failed {
            gate_index,
            message,
            retries_left,
        } => {
            assert_eq!((*gate_index, *retries_left), (0, 1));
            assert!(message.contains(&artifact), "{message}");
        }
        other => panic!("expected failed, got {other:?}"),
    }
    let headings = complete(&fx, &run, "t1", plan_artifact("# Plan\nonly")).unwrap();
    assert!(
        matches!(headings.status, StageStatus::Blocked { ref message } if message.contains("Risks"))
    );
    // A blocked stage waits for the user; Host continuation is refused.
    let blocked = settle(&fx, &headings.run, "t1", TurnOutcome::Completed);
    assert!(!blocked.continue_run);
    assert_eq!(blocked.run.wait_reason, Some(WaitReason::Retries));
    assert!(!claim(&fx, &blocked.run, "t-host", Origin::Host).claimed);
    let resumed = claim(&fx, &blocked.run, "t2", Origin::User);
    assert!(resumed.claimed && resumed.run.retry_counts.is_empty());

    let advanced = complete(
        &fx,
        &resumed.run,
        "t2",
        plan_artifact("## Plan\n```\n# Risks\n```\n### risks ##\n"),
    )
    .unwrap();
    assert_eq!(
        advanced.status,
        StageStatus::Advanced {
            next_stage_id: "work".into()
        }
    );
    assert!(fx.workspace.join(&artifact).is_file());
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Agent));

    let settled = settle(&fx, &advanced.run, "t2", TurnOutcome::Completed);
    assert!(settled.continue_run, "an advanced stage continues");
    let again = settle(&fx, &settled.run, "t2", TurnOutcome::Completed);
    assert!(
        !again.continue_run && !again.changed,
        "settle is idempotent"
    );
    assert_eq!(again.run.rounds_completed, 2);

    let host = claim(&fx, &settled.run, "t3", Origin::Host);
    assert!(host.claimed && host.entered_stage);
    let looped = settle(&fx, &host.run, "t3", TurnOutcome::Completed);
    assert!(looped.continue_run, "a loop stage continues");
    let host = claim(&fx, &looped.run, "t4", Origin::Host);
    assert!(host.claimed && !host.entered_stage);

    let finished = complete(&fx, &host.run, "t4", None).unwrap();
    assert_eq!(finished.status, StageStatus::Finished);
    assert_eq!(finished.run.state, RunState::Finished);
    assert!(finished.run.wire().get("finishedAt").is_some());
    assert_eq!(mode_row(&fx.db, &sid), ("agent".into(), None));
    assert!(open_run(&fx.db, &sid).unwrap().is_none());
    let last = settle(&fx, &finished.run, "t4", TurnOutcome::Completed);
    assert!(!last.continue_run);
    let gates: i64 = fx
        .db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM mode_gate_results WHERE run_id = ?1",
            [&run.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(gates, 3);
}

#[test]
fn goto_moves_to_the_named_stage_and_continues() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    let def = definition(
        "loopback",
        "agent",
        json!([
            { "id": "draft", "permission": "agent", "exit": [], "next": "check" },
            { "id": "check", "permission": "agent", "exit": [require(2, Some("draft"))] }
        ]),
    );
    configure(&fx.db, &sid, "loopback", Some(&def)).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    let first = settle(&fx, &run, "t1", TurnOutcome::Completed);
    assert!(
        first.continue_run,
        "a stage without gates passes at turn end"
    );
    assert_eq!(first.run.stage_id, "check");
    let claimed = claim(&fx, &first.run, "t2", Origin::Host);
    let outcome = complete(&fx, &claimed.run, "t2", None).unwrap();
    assert!(
        matches!(outcome.status, StageStatus::Goto { ref next_stage_id, .. } if next_stage_id == "draft")
    );
    assert_eq!(outcome.run.stage_id, "draft");
    assert!(settle(&fx, &outcome.run, "t2", TurnOutcome::Completed).continue_run);
}

#[test]
fn ask_gate_waits_for_approve_or_reject() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    let def = definition(
        "review",
        "contract",
        json!([
            { "id": "propose", "permission": "contract", "exit": [{ "kind": "ask" }], "next": "ship" },
            { "id": "ship", "permission": "agent", "exit": [] }
        ]),
    );
    configure(&fx.db, &sid, "review", Some(&def)).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    let asked = complete(&fx, &run, "t1", None).unwrap();
    assert_eq!(asked.status, StageStatus::AwaitingApproval);
    assert_eq!(asked.run.wire()["waitReason"], "approval");
    let settled = settle(&fx, &asked.run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run);

    let stale = resolve(
        &fx.db,
        ResolveParams {
            session_id: sid.clone(),
            run_id: run.id.clone(),
            expected_revision: settled.run.revision - 1,
            action: ResolveAction::Approve,
        },
    );
    assert_eq!(stale.unwrap_err().to_string(), "MODE_REVISION_CONFLICT");
    let rejected = resolve(
        &fx.db,
        ResolveParams {
            session_id: sid.clone(),
            run_id: run.id.clone(),
            expected_revision: settled.run.revision,
            action: ResolveAction::Reject,
        },
    )
    .unwrap();
    assert!(!rejected.continue_run);
    assert_eq!(rejected.run.wait_reason, Some(WaitReason::TurnEnd));
    let again = resolve(
        &fx.db,
        ResolveParams {
            session_id: sid.clone(),
            run_id: run.id.clone(),
            expected_revision: rejected.run.revision,
            action: ResolveAction::Approve,
        },
    );
    assert_eq!(again.unwrap_err().to_string(), "MODE_NOT_AWAITING_APPROVAL");

    let revised = claim(&fx, &rejected.run, "t2", Origin::User);
    assert!(revised.claimed);
    let asked = complete(&fx, &revised.run, "t2", None).unwrap();
    let settled = settle(&fx, &asked.run, "t2", TurnOutcome::Completed);
    let approved = resolve(
        &fx.db,
        ResolveParams {
            session_id: sid.clone(),
            run_id: run.id.clone(),
            expected_revision: settled.run.revision,
            action: ResolveAction::Approve,
        },
    )
    .unwrap();
    assert!(approved.continue_run);
    assert_eq!(approved.run.stage_id, "ship");
    let next = claim(&fx, &approved.run, "t3", Origin::Approval);
    assert!(next.claimed && next.entered_stage);
    let done = settle(&fx, &next.run, "t3", TurnOutcome::Completed);
    assert_eq!(done.run.state, RunState::Finished);
    assert_eq!(mode_row(&fx.db, &sid).0, "agent");
}

#[test]
fn budget_limits_host_claims_only() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    let mut def = definition(
        "grind",
        "agent",
        json!([{ "id": "work", "permission": "agent", "loop": true, "exit": [] }]),
    );
    def["budget"]["maxTurns"] = json!(1);
    configure(&fx.db, &sid, "grind", Some(&def)).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    let settled = settle(&fx, &run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run);
    assert_eq!(settled.run.state, RunState::BudgetExhausted);
    assert!(!claim(&fx, &settled.run, "t2", Origin::Host).claimed);
    let user = claim(&fx, &settled.run, "t2", Origin::User);
    assert!(user.claimed);
    assert_eq!(user.run.state, RunState::Running);
}

#[test]
fn pause_resume_stop_and_turn_outcomes() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    configure(&fx.db, &sid, "flow", Some(&flow())).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    let paused = control_run(&fx, &run, ControlAction::Pause).unwrap();
    assert_eq!(paused.run.state, RunState::Paused);
    assert_eq!(
        paused.run.active_turn_id.as_deref(),
        Some("t1"),
        "the turn runs to its end"
    );
    let settled = settle(&fx, &paused.run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run);
    assert_eq!(settled.run.state, RunState::Paused);
    let resumed = control_run(&fx, &settled.run, ControlAction::Resume).unwrap();
    assert!(resumed.continue_run);
    assert_eq!(resumed.run.state, RunState::Running);

    let aborted = claim(&fx, &resumed.run, "t2", Origin::Approval);
    let aborted = settle(&fx, &aborted.run, "t2", TurnOutcome::Aborted);
    assert_eq!(
        aborted.run.state,
        RunState::Paused,
        "composer Stop pauses the run"
    );
    let failed = claim(&fx, &aborted.run, "t3", Origin::User);
    let failed = settle(&fx, &failed.run, "t3", TurnOutcome::Error);
    assert_eq!(failed.run.wait_reason, Some(WaitReason::Error));
    assert_eq!(failed.run.last_error.as_deref(), Some("PROVIDER_FAILED"));

    let stale = control(
        &fx.db,
        ControlParams {
            session_id: sid.clone(),
            run_id: run.id.clone(),
            expected_revision: run.revision,
            action: ControlAction::Stop,
        },
    );
    assert_eq!(stale.unwrap_err().to_string(), "MODE_REVISION_CONFLICT");
    assert!(
        !claim_turn(
            &fx.db,
            ClaimParams {
                session_id: sid.clone(),
                run_id: run.id.clone(),
                expected_revision: run.revision,
                turn_id: "t4".into(),
                origin: Origin::User,
            },
        )
        .unwrap()
        .claimed,
        "a stale claim is refused, not an error"
    );

    let stopped = control_run(&fx, &failed.run, ControlAction::Stop).unwrap();
    assert_eq!(stopped.run.state, RunState::Stopped);
    assert!(stopped.run.active_turn_id.is_none() && stopped.run.finished_at.is_some());
    assert_eq!(mode_row(&fx.db, &sid), ("agent".into(), None));
    assert_eq!(
        control_run(&fx, &stopped.run, ControlAction::Resume)
            .unwrap_err()
            .to_string(),
        "MODE_RUN_CLOSED"
    );
}

#[test]
fn startup_recovery_pauses_claimed_runs_without_replay() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    configure(&fx.db, &sid, "flow", Some(&flow())).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    assert_eq!(recover(&fx.db).unwrap(), 1);
    let recovered = open_run(&fx.db, &sid).unwrap().unwrap();
    assert_eq!(recovered.state, RunState::Paused);
    assert!(recovered.active_turn_id.is_none() && recovered.active_origin.is_none());
    assert!(recovered.revision > run.revision);
    assert_eq!(recover(&fx.db).unwrap(), 0);
}

#[test]
fn configure_while_a_run_is_open() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    configure(&fx.db, &sid, "flow", Some(&flow())).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    settle(&fx, &run, "t1", TurnOutcome::Completed);
    assert!(configure(&fx.db, &sid, "flow", Some(&flow()))
        .unwrap()
        .is_none());
    let other = definition(
        "other",
        "agent",
        json!([{ "id": "s", "permission": "agent", "exit": [] }]),
    );
    assert_eq!(
        configure(&fx.db, &sid, "other", Some(&other))
            .unwrap_err()
            .to_string(),
        "MODE_RUN_ACTIVE"
    );
    let paused = configure(&fx.db, &sid, "agent", None).unwrap().unwrap();
    assert_eq!(paused.state, RunState::Paused);
    // The run no longer governs a session that left its mode.
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Agent));
    assert_eq!(
        start(
            &fx.db,
            &fx.workspace,
            StartParams {
                session_id: sid.clone(),
                input: String::new(),
                turn_id: "t2".into()
            }
        )
        .unwrap_err()
        .to_string(),
        "MODE_NOT_STAGED"
    );
    configure(&fx.db, &sid, "flow", Some(&flow())).unwrap();
    assert_eq!(
        start(
            &fx.db,
            &fx.workspace,
            StartParams {
                session_id: sid.clone(),
                input: String::new(),
                turn_id: "t2".into()
            }
        )
        .unwrap_err()
        .to_string(),
        "MODE_RUN_ACTIVE"
    );
    assert_eq!(
        configure(&fx.db, &sid, "custom", None)
            .unwrap_err()
            .to_string(),
        "MODE_SNAPSHOT_REQUIRED"
    );
}

#[test]
fn tool_policy_resolution_order() {
    let fx = fixture();
    for (mode, expected) in [
        ("agent", ToolPolicy::Agent),
        ("plan", ToolPolicy::Contract),
        ("goal", ToolPolicy::Contract),
        ("unknown-custom", ToolPolicy::Contract),
    ] {
        let sid = session(&fx, mode);
        assert_eq!(policy(&fx, &sid), Some(expected), "{mode}");
    }
    assert_eq!(policy(&fx, "missing"), None);

    let sid = session(&fx, "agent");
    let simple = json!({
        "version": 1, "id": "scribe", "label": "", "description": "", "permission": "agent",
        "prompt": "", "source": "user", "artifacts": [], "budget": { "maxTurns": 20, "maxTokens": null },
        "returnTo": "agent", "stages": []
    });
    configure(&fx.db, &sid, "scribe", Some(&simple)).unwrap();
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Agent));
    let mut contract = simple.clone();
    contract["permission"] = json!("contract");
    configure(&fx.db, &sid, "scribe", Some(&contract)).unwrap();
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Contract));

    // The staged builtin Goal works under its stage's agent permission.
    configure(&fx.db, &sid, "goal", Some(&goal_snapshot())).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    assert_eq!(run.max_turns, Some(20));
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Agent));
    // Builtin agent and plan never take a snapshot, whatever is sent.
    let paused = configure(&fx.db, &sid, "plan", Some(&simple)).unwrap();
    assert!(paused.is_some());
    assert_eq!(mode_row(&fx.db, &sid), ("plan".into(), None));
    assert_eq!(policy(&fx, &sid), Some(ToolPolicy::Contract));
}

#[test]
fn custom_mode_ids_survive_normalization_and_reads() {
    assert_eq!(sessions::normalize_mode(Some("review")), "review");
    assert_eq!(sessions::normalize_mode(Some("chat")), "plan");
    assert_eq!(sessions::normalize_mode(Some("Not Valid")), "agent");
    assert_eq!(sessions::normalize_mode(None), "agent");
    assert_eq!(sessions::normalize_builtin_mode(Some("review")), "agent");
    assert!(sessions::is_valid_mode("deep-review2"));
    assert!(!sessions::is_valid_mode("2fast"));
    assert!(!sessions::is_valid_mode(&"a".repeat(41)));
    let fx = fixture();
    let sid = session(&fx, "review");
    assert_eq!(
        sessions::session_mode(&fx.db, &sid).unwrap().as_deref(),
        Some("review")
    );
}

#[test]
fn artifacts_cannot_escape_the_workspace() {
    let fx = fixture();
    let outside = fx.workspace.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, fx.workspace.join(".pi")).unwrap();
        let error = artifacts::write(&fx.workspace, ".pi/flow/x.md", "# Plan")
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("MODE_ARTIFACT_PATH"), "{error}");
        assert!(!outside.join("flow").exists());
    }
    let error = artifacts::write(&fx.workspace, "../x.md", "x")
        .unwrap_err()
        .to_string();
    assert!(error.starts_with("MODE_ARTIFACT_PATH"), "{error}");
    let big = "x".repeat(artifacts::MAX_ARTIFACT_BYTES + 1);
    assert!(artifacts::write(&fx.workspace, "big.md", &big)
        .unwrap_err()
        .to_string()
        .starts_with("MODE_ARTIFACT_TOO_LARGE"));
}

#[test]
fn completing_a_stage_requires_the_claim_and_declared_artifacts() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    configure(&fx.db, &sid, "flow", Some(&flow())).unwrap();
    let run = start_run(&fx, &sid, "t1").run;
    assert_eq!(
        complete(&fx, &run, "other-turn", None)
            .unwrap_err()
            .to_string(),
        "MODE_CLAIM_MISMATCH"
    );
    let unknown = Some(BTreeMap::from([("nope".to_string(), "x".to_string())]));
    assert!(complete(&fx, &run, "t1", unknown)
        .unwrap_err()
        .to_string()
        .starts_with("MODE_ARTIFACT_UNKNOWN"));
}
