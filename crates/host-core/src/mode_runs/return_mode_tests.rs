//! A closed run's `returnTo` (#2204): a deleted mode falls back to `agent`,
//! an existing custom mode gets its snapshot and policy back.

use serde_json::{json, Value};

use super::model::*;
use super::return_mode::{SettleReturnParams, SettleReturnResult};
use super::tests::{control_run, definition, fixture, mode_row, session, start_run, Fixture};
use super::*;

fn returning_to(target: &str) -> Value {
    let mut def = definition(
        "feature",
        "contract",
        json!([{ "id": "work", "permission": "agent", "loop": true, "exit": [] }]),
    );
    def["returnTo"] = json!(target);
    def
}

fn review() -> Value {
    definition("review", "agent", json!([]))
}

/// A run of `feature` that the user stopped; the session sits on `review`.
fn closed_run(fx: &Fixture) -> (String, ModeRun) {
    let sid = session(fx, "agent");
    super::tests::configure(&fx.db, &sid, "feature", Some(&returning_to("review"))).unwrap();
    let run = start_run(fx, &sid, "t1").run;
    let stopped = control_run(fx, &run, ControlAction::Stop).unwrap().run;
    assert_eq!(mode_row(&fx.db, &sid), ("review".into(), None));
    (sid, stopped)
}

fn settle(
    fx: &Fixture,
    run: &ModeRun,
    mode: Option<&str>,
    snapshot: Option<Value>,
) -> SettleReturnResult {
    settle_return(
        &fx.db,
        SettleReturnParams {
            session_id: run.session_id.clone(),
            run_id: run.id.clone(),
            mode: mode.map(str::to_owned),
            mode_snapshot: snapshot,
        },
    )
    .unwrap()
}

#[test]
fn a_deleted_return_mode_falls_back_to_agent() {
    let fx = fixture();
    let (sid, run) = closed_run(&fx);
    // Without a snapshot the stranded custom id fails closed (the bug).
    assert_eq!(
        tool_policy(&fx.db, &sid).unwrap(),
        Some(ToolPolicy::Contract)
    );

    assert_eq!(
        settle(&fx, &run, None, None),
        SettleReturnResult::Pending("review".into())
    );
    assert_eq!(
        settle(&fx, &run, Some("review"), None),
        SettleReturnResult::Applied("agent".into())
    );
    assert_eq!(mode_row(&fx.db, &sid), ("agent".into(), None));
    assert_eq!(tool_policy(&fx.db, &sid).unwrap(), Some(ToolPolicy::Agent));
    assert_eq!(settle(&fx, &run, None, None), SettleReturnResult::Settled);
}

#[test]
fn an_existing_return_mode_gets_its_snapshot_and_policy() {
    let fx = fixture();
    let (sid, run) = closed_run(&fx);
    assert_eq!(
        settle(&fx, &run, Some("review"), Some(review())),
        SettleReturnResult::Applied("review".into())
    );
    let (mode, hash) = mode_row(&fx.db, &sid);
    assert_eq!(mode, "review");
    assert!(hash.is_some());
    assert_eq!(tool_policy(&fx.db, &sid).unwrap(), Some(ToolPolicy::Agent));
}

#[test]
fn settling_never_overrides_a_mode_the_user_chose() {
    let fx = fixture();
    let (sid, run) = closed_run(&fx);
    super::tests::configure(&fx.db, &sid, "plan", None).unwrap();
    assert_eq!(settle(&fx, &run, None, None), SettleReturnResult::Settled);
    assert_eq!(
        settle(&fx, &run, Some("review"), None),
        SettleReturnResult::Settled
    );
    assert_eq!(mode_row(&fx.db, &sid), ("plan".into(), None));
}

#[test]
fn an_open_run_or_a_builtin_return_mode_needs_nothing() {
    let fx = fixture();
    let sid = session(&fx, "agent");
    super::tests::configure(&fx.db, &sid, "feature", Some(&returning_to("review"))).unwrap();
    let open = start_run(&fx, &sid, "t1").run;
    assert_eq!(
        settle(&fx, &open, Some("feature"), None),
        SettleReturnResult::Settled
    );
    assert_eq!(mode_row(&fx.db, &sid).0, "feature");

    let other = session(&fx, "agent");
    super::tests::configure(&fx.db, &other, "feature", Some(&returning_to("agent"))).unwrap();
    let run = start_run(&fx, &other, "t1").run;
    let stopped = control_run(&fx, &run, ControlAction::Stop).unwrap().run;
    assert_eq!(
        settle(&fx, &stopped, None, None),
        SettleReturnResult::Settled
    );
}

#[test]
fn a_snapshot_for_another_mode_is_rejected() {
    let fx = fixture();
    let (sid, run) = closed_run(&fx);
    let err = settle_return(
        &fx.db,
        SettleReturnParams {
            session_id: sid.clone(),
            run_id: run.id.clone(),
            mode: Some("review".into()),
            mode_snapshot: Some(definition("other", "agent", json!([]))),
        },
    );
    assert!(err.is_err());
    assert_eq!(mode_row(&fx.db, &sid), ("review".into(), None));
}
