//! Run state machine: start, claims, settlement, control, approval and the
//! session-mode coupling. Gate evaluation lives in `gates.rs`.
//!
//! The claim / revision-CAS / budget / settlement design is ported from PR
//! #2141 by new-Beginner (`goals/lifecycle.rs`, `goals/execution.rs`).

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;
use serde_json::Value;

use super::artifacts;
use super::model::{
    ClaimParams, ClaimResult, ContinueResult, ControlAction, ControlParams, ModeRun, Origin,
    ResolveAction, ResolveParams, RunState, SettleParams, StartParams, TurnOutcome, WaitReason,
    MAX_SAFE_INTEGER, MAX_TEXT_BYTES, SETTLED_TURNS_KEPT,
};
use super::repository::{self, GateRecord};
use super::snapshot::{self, ModeDefinition, Snapshot};
use super::{mode_error, mode_error_detail};
use crate::db::{now_ms, Database};

/// Where a passed stage leads.
pub(super) enum Transition {
    Advanced(String),
    Finished,
}

fn invalid_argument(detail: &str) -> anyhow::Error {
    mode_error_detail("MODE_INVALID_ARGUMENT", detail)
}

fn require_text(value: &str, name: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(invalid_argument(&format!("{name} is required")));
    }
    if value.len() > MAX_TEXT_BYTES {
        return Err(invalid_argument(&format!("{name} is too long")));
    }
    Ok(())
}

/// Leave the stage after every gate passed: advance to `next`, or finish the
/// run and hand the session back to `returnTo`. The caller persists `run`
/// and calls `apply_finish` inside the same transaction.
pub(super) fn pass_transition(run: &mut ModeRun, definition: &ModeDefinition) -> Transition {
    let next = definition
        .stage(&run.stage_id)
        .and_then(|stage| stage.next.clone());
    match next {
        Some(next) => {
            let previous = run.stage_id.clone();
            run.clear_retries(&previous);
            run.enter_stage(&next);
            run.set_state(RunState::Running);
            Transition::Advanced(next)
        }
        None => {
            finish(run, RunState::Finished);
            Transition::Finished
        }
    }
}

fn finish(run: &mut ModeRun, state: RunState) {
    run.set_state(state);
    run.clear_claim();
    run.advanced_in_turn = false;
    run.finished_at = Some(now_ms());
}

/// Session-side effect of a closed run.
pub(super) fn apply_finish(conn: &Connection, run: &ModeRun, definition: &ModeDefinition) -> Result<()> {
    if run.state.is_open() {
        return Ok(());
    }
    repository::return_session_mode(conn, &run.session_id, &run.mode_id, &definition.return_to)
}

fn load_run(conn: &Connection, session_id: &str, run_id: &str) -> Result<(ModeRun, Snapshot)> {
    let run = repository::owned(conn, session_id, run_id)?;
    let snapshot = snapshot::require(conn, &run.snapshot_hash)?;
    Ok((run, snapshot))
}

/// The session's open run.
pub fn open_run(db: &Database, session_id: &str) -> Result<Option<ModeRun>> {
    repository::open_run(db.conn(), session_id)
}

/// `modes.start`: open a run of the session's staged mode for the user turn
/// that started it. `workspace` receives template artifacts.
pub fn start(db: &Database, workspace: &Path, params: StartParams) -> Result<ClaimResult> {
    require_text(&params.turn_id, "turnId")?;
    if params.input.len() > MAX_TEXT_BYTES {
        return Err(invalid_argument("input is too long"));
    }
    let conn = db.conn();
    let (mode, hash) = repository::session_mode_row(conn, &params.session_id)?
        .ok_or_else(|| mode_error("MODE_SESSION_NOT_FOUND"))?;
    let snapshot = match hash {
        Some(hash) => snapshot::load(conn, &hash)?,
        None => None,
    }
    .filter(|snapshot| snapshot.definition.id == mode && snapshot.definition.is_staged())
    .ok_or_else(|| mode_error("MODE_NOT_STAGED"))?;
    if repository::open_run(conn, &params.session_id)?.is_some() {
        return Err(mode_error("MODE_RUN_ACTIVE"));
    }
    let definition = &snapshot.definition;
    let first = definition
        .stages
        .first()
        .ok_or_else(|| mode_error("MODE_NOT_STAGED"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let artifact_paths: BTreeMap<String, String> = definition
        .artifacts
        .iter()
        .map(|artifact| {
            (
                artifact.id.clone(),
                snapshot::substitute_run_id(&artifact.path, &id),
            )
        })
        .collect();
    let now = now_ms();
    let run = ModeRun {
        id,
        session_id: params.session_id,
        mode_id: mode,
        snapshot_hash: snapshot.hash.clone(),
        input: params.input,
        stage_id: first.id.clone(),
        state: RunState::Running,
        wait_reason: None,
        last_error: None,
        revision: 1,
        active_turn_id: Some(params.turn_id),
        active_origin: Some(Origin::User),
        // This claim reports the entry itself.
        stage_entered: false,
        advanced_in_turn: false,
        pending_gate: None,
        retry_counts: BTreeMap::new(),
        rounds_completed: 0,
        tokens_used: 0,
        max_turns: definition.budget.max_turns,
        max_tokens: definition.budget.max_tokens,
        artifact_paths,
        settled_turns: Vec::new(),
        created_at: now,
        updated_at: now,
        finished_at: None,
    };
    repository::insert(conn, &run)?;
    if let Err(error) = artifacts::seed_templates(workspace, definition, &run.artifact_paths) {
        // The run is valid without its templates; the agent writes the file.
        tracing::warn!(run_id = %run.id, %error, "mode run template seeding failed");
    }
    Ok(ClaimResult {
        claimed: true,
        run,
        entered_stage: true,
        definition: Some(snapshot.value),
        changed: true,
    })
}

fn not_claimed(run: ModeRun) -> ClaimResult {
    ClaimResult {
        claimed: false,
        run,
        entered_stage: false,
        definition: None,
        changed: false,
    }
}

/// `modes.claimTurn`: bind a turn to the run. A refused claim is a normal
/// answer (`claimed: false`), never an error.
pub fn claim_turn(db: &Database, params: ClaimParams) -> Result<ClaimResult> {
    require_text(&params.turn_id, "turnId")?;
    let conn = db.conn();
    let (mut run, snapshot) = load_run(conn, &params.session_id, &params.run_id)?;
    if run.claimed_by(&params.turn_id) && run.state == RunState::Running {
        return Ok(ClaimResult {
            claimed: true,
            run,
            entered_stage: false,
            definition: Some(snapshot.value),
            changed: false,
        });
    }
    if !run.state.is_open()
        || run.active_turn_id.is_some()
        || run.revision != params.expected_revision
    {
        return Ok(not_claimed(run));
    }
    let mut superseded_ask = None;
    match params.origin {
        Origin::Host => {
            if run.state != RunState::Running || run.budget_exhausted() {
                return Ok(not_claimed(run));
            }
        }
        Origin::Approval => {
            if run.state != RunState::Running {
                return Ok(not_claimed(run));
            }
        }
        Origin::User => {
            match (run.state, run.wait_reason) {
                (RunState::Waiting, Some(WaitReason::Approval)) => {
                    // A message instead of a decision rejects the ask gate.
                    superseded_ask = snapshot
                        .definition
                        .stage(&run.stage_id)
                        .and_then(|stage| stage.exit.len().checked_sub(1));
                }
                (RunState::Waiting, Some(WaitReason::Retries)) => {
                    let stage = run.stage_id.clone();
                    run.clear_retries(&stage);
                }
                _ => {}
            }
            run.set_state(RunState::Running);
        }
    }
    let entered_stage = run.stage_entered;
    run.stage_entered = false;
    run.advanced_in_turn = false;
    run.pending_gate = None;
    run.last_error = None;
    run.active_turn_id = Some(params.turn_id);
    run.active_origin = Some(params.origin);
    let tx = conn.unchecked_transaction()?;
    if let Some(gate_index) = superseded_ask {
        repository::record_gate(
            &tx,
            &run.id,
            GateRecord {
                stage_id: &run.stage_id,
                gate_index,
                action: "ask",
                passed: Some(false),
                evidence: Some("superseded by a user message"),
                tool_call_id: None,
            },
        )?;
    }
    repository::save(&tx, &mut run)?;
    tx.commit()?;
    Ok(ClaimResult {
        claimed: true,
        run,
        entered_stage,
        definition: Some(snapshot.value),
        changed: true,
    })
}

fn remember_settled(run: &mut ModeRun, turn_id: &str) {
    run.settled_turns.push(turn_id.to_string());
    let excess = run.settled_turns.len().saturating_sub(SETTLED_TURNS_KEPT);
    if excess > 0 {
        run.settled_turns.drain(..excess);
    }
}

/// `modes.settleTurn`: account a finished turn and decide whether the Host
/// should start the next one. Idempotent per turn id.
pub fn settle_turn(db: &Database, params: SettleParams) -> Result<ContinueResult> {
    require_text(&params.turn_id, "turnId")?;
    let conn = db.conn();
    let (mut run, snapshot) = load_run(conn, &params.session_id, &params.run_id)?;
    if run.settled_turns.iter().any(|turn| turn == &params.turn_id) {
        return Ok(ContinueResult {
            run,
            continue_run: false,
            changed: false,
        });
    }
    let held = run.claimed_by(&params.turn_id);
    remember_settled(&mut run, &params.turn_id);
    run.tokens_used = run
        .tokens_used
        .saturating_add(params.tokens.max(0))
        .min(MAX_SAFE_INTEGER);
    if params.outcome == TurnOutcome::Completed {
        run.rounds_completed = run.rounds_completed.saturating_add(1);
    }
    let definition = &snapshot.definition;
    let mut continue_run = false;
    if held && run.state.is_open() {
        run.clear_claim();
        match params.outcome {
            TurnOutcome::Aborted => run.set_state(RunState::Paused),
            TurnOutcome::Error => {
                run.set_waiting(WaitReason::Error);
                let error = params.error.as_deref().unwrap_or("the turn failed");
                run.last_error = Some(super::model::tail(error, 2_000));
            }
            TurnOutcome::Completed if run.state == RunState::Running => {
                let stage = definition.stage(&run.stage_id);
                if run.advanced_in_turn || stage.is_some_and(|stage| stage.looping) {
                    continue_run = true;
                } else if stage.is_some_and(|stage| stage.exit.is_empty()) {
                    continue_run = matches!(
                        pass_transition(&mut run, definition),
                        Transition::Advanced(_)
                    );
                } else {
                    run.set_waiting(WaitReason::TurnEnd);
                }
            }
            TurnOutcome::Completed => {}
        }
        if continue_run && run.budget_exhausted() {
            run.set_state(RunState::BudgetExhausted);
            continue_run = false;
        }
        run.advanced_in_turn = false;
    } else if held {
        run.clear_claim();
    }
    let tx = conn.unchecked_transaction()?;
    repository::save(&tx, &mut run)?;
    apply_finish(&tx, &run, definition)?;
    tx.commit()?;
    Ok(ContinueResult {
        run,
        continue_run,
        changed: true,
    })
}

fn check_revision(run: &ModeRun, expected: i64) -> Result<()> {
    if run.revision != expected {
        return Err(mode_error("MODE_REVISION_CONFLICT"));
    }
    Ok(())
}

fn unchanged(run: ModeRun) -> ContinueResult {
    ContinueResult {
        run,
        continue_run: false,
        changed: false,
    }
}

/// `modes.control`: user pause / resume / stop.
pub fn control(db: &Database, params: ControlParams) -> Result<ContinueResult> {
    let conn = db.conn();
    let (mut run, snapshot) = load_run(conn, &params.session_id, &params.run_id)?;
    check_revision(&run, params.expected_revision)?;
    if !run.state.is_open() {
        return Err(mode_error("MODE_RUN_CLOSED"));
    }
    let mut continue_run = false;
    match params.action {
        // The current turn runs to its end; only Host continuation stops.
        ControlAction::Pause => match run.state {
            RunState::Running | RunState::Waiting | RunState::BudgetExhausted => {
                run.set_state(RunState::Paused)
            }
            _ => return Ok(unchanged(run)),
        },
        ControlAction::Resume => match run.state {
            RunState::Paused | RunState::BudgetExhausted => {
                run.set_state(RunState::Running);
                continue_run = run.active_turn_id.is_none();
            }
            _ => return Ok(unchanged(run)),
        },
        ControlAction::Stop => finish(&mut run, RunState::Stopped),
    }
    let tx = conn.unchecked_transaction()?;
    repository::save(&tx, &mut run)?;
    apply_finish(&tx, &run, &snapshot.definition)?;
    tx.commit()?;
    Ok(ContinueResult {
        run,
        continue_run,
        changed: true,
    })
}

/// `modes.resolve`: the user's answer to an `ask` gate.
pub fn resolve(db: &Database, params: ResolveParams) -> Result<ContinueResult> {
    let conn = db.conn();
    let (mut run, snapshot) = load_run(conn, &params.session_id, &params.run_id)?;
    check_revision(&run, params.expected_revision)?;
    if run.state != RunState::Waiting || run.wait_reason != Some(WaitReason::Approval) {
        return Err(mode_error("MODE_NOT_AWAITING_APPROVAL"));
    }
    let definition = &snapshot.definition;
    let gate_index = definition
        .stage(&run.stage_id)
        .and_then(|stage| stage.exit.len().checked_sub(1))
        .unwrap_or(0);
    let stage_id = run.stage_id.clone();
    let approved = params.action == ResolveAction::Approve;
    let mut continue_run = false;
    if approved {
        if let Transition::Advanced(_) = pass_transition(&mut run, definition) {
            // A turn still holding the claim continues from its own
            // settlement; otherwise Main starts the next turn now.
            let claimed = run.active_turn_id.is_some();
            run.advanced_in_turn = claimed;
            continue_run = !claimed;
        }
    } else {
        run.set_waiting(WaitReason::TurnEnd);
    }
    let tx = conn.unchecked_transaction()?;
    repository::record_gate(
        &tx,
        &run.id,
        GateRecord {
            stage_id: &stage_id,
            gate_index,
            action: "ask",
            passed: Some(approved),
            evidence: Some(if approved { "approved" } else { "rejected" }),
            tool_call_id: None,
        },
    )?;
    repository::save(&tx, &mut run)?;
    apply_finish(&tx, &run, definition)?;
    tx.commit()?;
    Ok(ContinueResult {
        run,
        continue_run,
        changed: true,
    })
}

/// Startup recovery: claims die with the process that held them. Their runs
/// pause; nothing is replayed.
pub fn recover(db: &Database) -> Result<usize> {
    Ok(repository::release_stale_claims(db.conn())?.len())
}

/// Verify a `tools.execute` Bash call that claims to run a pending `run`
/// gate: same run, claim held, the gate pending, the snapshot command
/// byte-for-byte. Anything else is `MODE_GATE_MISMATCH`.
pub fn verify_gate_command(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    run_id: &str,
    gate_index: i64,
    command: &str,
) -> Result<()> {
    let mismatch = || mode_error("MODE_GATE_MISMATCH");
    let (run, snapshot) = load_run(db.conn(), session_id, run_id).map_err(|_| mismatch())?;
    let claim_ok = run.state == RunState::Running
        && run.active_turn_id.is_some()
        && turn_id.is_none_or(|turn| run.claimed_by(turn));
    if !claim_ok || run.pending_gate != Some(gate_index) {
        return Err(mismatch());
    }
    let expected = usize::try_from(gate_index)
        .ok()
        .and_then(|index| snapshot.definition.stage(&run.stage_id)?.exit.get(index));
    match expected {
        Some(snapshot::ModeGate::Run { command: expected, .. }) if expected == command => Ok(()),
        _ => Err(mismatch()),
    }
}

/// A validated `session.configure` mode change, before anything is written.
#[derive(Debug)]
pub struct PreparedMode {
    snapshot: Option<Snapshot>,
    pause: Option<ModeRun>,
}

impl PreparedMode {
    pub fn snapshot_hash(&self) -> Option<&str> {
        self.snapshot.as_ref().map(|snapshot| snapshot.hash.as_str())
    }
}

/// Validate the mode a `session.configure` asks for. Builtin `agent` and
/// `plan` never take a snapshot (their behavior is fixed); `goal` and custom
/// ids use the snapshot Main sends, and a custom id without one is refused.
pub fn prepare_session_mode(
    db: &Database,
    session_id: &str,
    requested: &str,
    snapshot_value: Option<&Value>,
) -> Result<PreparedMode> {
    let mode = crate::sessions::normalize_mode(Some(requested));
    let snapshot = match snapshot_value.filter(|value| !value.is_null()) {
        Some(_) if matches!(mode.as_str(), "agent" | "plan") => None,
        Some(value) => Some(snapshot::validate(value, &mode)?),
        None if crate::sessions::is_builtin_mode(&mode) => None,
        None => return Err(mode_error("MODE_SNAPSHOT_REQUIRED")),
    };
    let mut pause = None;
    if let Some(run) = repository::open_run(db.conn(), session_id)? {
        if run.mode_id != mode {
            if snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.definition.is_staged())
            {
                return Err(mode_error("MODE_RUN_ACTIVE"));
            }
            if run.state != RunState::Paused {
                pause = Some(run);
            }
        }
    }
    Ok(PreparedMode {
        snapshot,
        pause,
    })
}

/// Persist the snapshot before the session row references it.
pub fn store_session_snapshot(db: &Database, prepared: &PreparedMode) -> Result<()> {
    if let Some(snapshot) = &prepared.snapshot {
        snapshot::store(db.conn(), snapshot)?;
    }
    Ok(())
}

/// After the session switched away from an open run's mode, pause that run.
/// Returns the run when it changed.
pub fn configure_session_mode(db: &Database, prepared: PreparedMode) -> Result<Option<ModeRun>> {
    let Some(mut run) = prepared.pause else {
        return Ok(None);
    };
    run.set_state(RunState::Paused);
    repository::save(db.conn(), &mut run)?;
    Ok(Some(run))
}
