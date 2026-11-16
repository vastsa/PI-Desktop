//! User edits of an open run: objective and budget (`modes.update`), the
//! Goal default budget from settings, and Remove versus Stop.

use std::collections::BTreeMap;

use serde_json::json;

use super::budget::RunBudget;
use super::model::*;
use super::snapshot_tests::goal_snapshot;
use super::tests::{claim, configure, control_run, fixture, mode_row, session, settle, start_run};
use super::*;

fn update_run(
    fx: &super::tests::Fixture,
    run: &ModeRun,
    input: Option<&str>,
    budget: Option<RunBudget>,
) -> anyhow::Result<ContinueResult> {
    update(
        &fx.db,
        UpdateParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            expected_revision: run.revision,
            input: input.map(str::to_string),
            budget,
        },
    )
}

fn complete_with_input(
    fx: &super::tests::Fixture,
    run: &ModeRun,
    turn: &str,
    input: &str,
) -> anyhow::Result<StageOutcome> {
    let artifact = "# Objective\nx\n# Acceptance criteria\nx\n# Evidence\nx\n";
    complete_stage(
        &fx.db,
        &fx.workspace,
        CompleteStageParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            turn_id: turn.into(),
            summary: "done".into(),
            artifacts: Some(BTreeMap::from([("goal".to_string(), artifact.to_string())])),
            input: Some(input.into()),
            report: None,
        },
    )
}

fn goal_session(fx: &super::tests::Fixture) -> String {
    let sid = session(fx, "agent");
    configure(&fx.db, &sid, "goal", Some(&goal_snapshot())).unwrap();
    sid
}

#[test]
fn edited_objective_applies_from_the_next_claim_only() {
    let fx = fixture();
    let sid = goal_session(&fx);
    let run = start_run(&fx, &sid, "t1").run;
    assert_eq!(run.input, "ship it");

    let edited = update_run(&fx, &run, Some("ship it with docs"), None).unwrap();
    assert!(edited.changed && !edited.continue_run);
    assert_eq!(edited.run.input, "ship it with docs");
    assert_eq!(
        edited.run.active_turn_id.as_deref(),
        Some("t1"),
        "editing never interrupts the turn"
    );
    // The turn that was claimed for the old objective cannot finish the run.
    let stale = complete_with_input(&fx, &edited.run, "t1", "ship it").unwrap_err();
    assert_eq!(stale.to_string(), "MODE_INPUT_CHANGED");

    let settled = settle(&fx, &edited.run, "t1", TurnOutcome::Completed);
    assert!(settled.continue_run);
    let next = claim(&fx, &settled.run, "t2", Origin::Host);
    assert!(next.claimed);
    assert_eq!(next.run.input, "ship it with docs");
    let done = complete_with_input(&fx, &next.run, "t2", "ship it with docs").unwrap();
    assert_eq!(done.status, StageStatus::Finished);

    // The edit survives a reload of the row.
    let fx2 = fixture();
    let sid2 = goal_session(&fx2);
    let run2 = start_run(&fx2, &sid2, "t1").run;
    update_run(&fx2, &run2, Some("new"), None).unwrap();
    assert_eq!(open_run(&fx2.db, &sid2).unwrap().unwrap().input, "new");
}

#[test]
fn update_validates_and_checks_the_revision() {
    let fx = fixture();
    let sid = goal_session(&fx);
    let run = start_run(&fx, &sid, "t1").run;
    let empty = update_run(&fx, &run, Some("  "), None).unwrap_err();
    assert!(empty.to_string().starts_with("MODE_INVALID_ARGUMENT"));
    let range = update_run(
        &fx,
        &run,
        None,
        Some(RunBudget {
            max_turns: Some(0),
            max_tokens: None,
        }),
    )
    .unwrap_err();
    assert!(range.to_string().starts_with("MODE_INVALID_ARGUMENT"));
    let same = update_run(&fx, &run, Some("ship it"), None).unwrap();
    assert!(!same.changed, "an unchanged value is a no-op");

    let first = update_run(&fx, &run, Some("a"), None).unwrap();
    let stale = update_run(&fx, &run, Some("b"), None).unwrap_err();
    assert_eq!(stale.to_string(), "MODE_REVISION_CONFLICT");
    let stopped = control_run(&fx, &first.run, ControlAction::Stop).unwrap();
    assert_eq!(
        update_run(&fx, &stopped.run, Some("c"), None)
            .unwrap_err()
            .to_string(),
        "MODE_RUN_CLOSED"
    );
}

#[test]
fn per_run_budget_change_limits_and_unblocks_host_turns() {
    let fx = fixture();
    let sid = goal_session(&fx);
    let run = start_run(&fx, &sid, "t1").run;
    let limited = update_run(
        &fx,
        &run,
        None,
        Some(RunBudget {
            max_turns: Some(1),
            max_tokens: None,
        }),
    )
    .unwrap();
    assert_eq!(limited.run.max_turns, Some(1));
    let settled = settle(&fx, &limited.run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run);
    assert_eq!(settled.run.state, RunState::BudgetExhausted);

    // Raising the limit does not resume by itself; Resume does.
    let raised = update_run(
        &fx,
        &settled.run,
        None,
        Some(RunBudget {
            max_turns: None,
            max_tokens: None,
        }),
    )
    .unwrap();
    assert_eq!(raised.run.state, RunState::BudgetExhausted);
    assert_eq!(raised.run.max_turns, None);
    let resumed = control_run(&fx, &raised.run, ControlAction::Resume).unwrap();
    assert!(resumed.continue_run);
    assert!(claim(&fx, &resumed.run, "t2", Origin::Host).claimed);
}

#[test]
fn goal_runs_take_the_settings_budget_and_other_modes_do_not() {
    let fx = fixture();
    fx.db
        .set_setting(
            "app",
            &json!({ "goalBudget": { "maxTurns": 3, "maxTokens": 50_000 } }),
        )
        .unwrap();
    let sid = goal_session(&fx);
    let run = start_run(&fx, &sid, "t1").run;
    assert_eq!((run.max_turns, run.max_tokens), (Some(3), Some(50_000)));

    let other = session(&fx, "agent");
    let def = super::tests::definition(
        "grind",
        "agent",
        json!([{ "id": "work", "permission": "agent", "loop": true, "exit": [] }]),
    );
    configure(&fx.db, &other, "grind", Some(&def)).unwrap();
    let run = start_run(&fx, &other, "t2").run;
    assert_eq!(
        (run.max_turns, run.max_tokens),
        (Some(20), None),
        "a user mode keeps its own budget"
    );

    // An invalid stored value falls back to the definition budget.
    fx.db
        .set_setting("app", &json!({ "goalBudget": { "maxTurns": -1 } }))
        .unwrap();
    let third = session(&fx, "agent");
    configure(&fx.db, &third, "goal", Some(&goal_snapshot())).unwrap();
    let run = start_run(&fx, &third, "t3").run;
    assert_eq!((run.max_turns, run.max_tokens), (Some(20), None));
}

#[test]
fn remove_ends_the_run_and_keeps_the_turn_for_the_return_mode() {
    let fx = fixture();
    let sid = goal_session(&fx);
    let run = start_run(&fx, &sid, "t1").run;
    let removed = control_run(&fx, &run, ControlAction::Remove).unwrap();
    assert!(!removed.continue_run);
    assert_eq!(removed.run.state, RunState::Stopped);
    assert!(removed.run.active_turn_id.is_none());
    assert_eq!(mode_row(&fx.db, &sid), ("agent".into(), None));
    // The turn still running settles as accounting only: no next turn, no
    // revival of the removed run.
    let settled = settle(&fx, &removed.run, "t1", TurnOutcome::Completed);
    assert!(!settled.continue_run);
    assert_eq!(settled.run.state, RunState::Stopped);
    assert!(open_run(&fx.db, &sid).unwrap().is_none());
    // A late stage report from that turn cannot complete the run.
    assert_eq!(
        complete_with_input(&fx, &settled.run, "t1", "ship it")
            .unwrap_err()
            .to_string(),
        "MODE_CLAIM_MISMATCH"
    );
}
