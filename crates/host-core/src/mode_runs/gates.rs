//! Exit gates: `modes.completeStage` evaluates a stage's gates in order,
//! `modes.gateResult` resumes after a `run` gate whose exit code
//! `tools.execute` recorded. Every evaluated gate is persisted.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use anyhow::Result;

use super::artifacts;
use super::engine::{apply_finish, pass_transition, Transition};
use super::model::{
    tail, CompleteStageParams, GateResultParams, ModeRun, RunState, StageOutcome, StageStatus,
    WaitReason, MAX_TEXT_BYTES,
};
use super::repository::{self, GateRecord, MAX_EVIDENCE_BYTES};
use super::snapshot::{self, GateFailure, ModeDefinition, ModeGate};
use super::{mode_error, mode_error_detail};
use crate::db::Database;

/// Gate exit codes waiting for their `modes.gateResult`. Process-local: a
/// restart releases every claim, so no pending gate survives it.
const MAX_PENDING_EXECUTIONS: usize = 64;

/// One `run` gate command `tools.execute` finished.
#[derive(Debug, Clone)]
pub struct GateExecution {
    pub run_id: String,
    pub gate_index: i64,
    pub exit_code: Option<i64>,
    pub output_tail: String,
    recorded_at: Instant,
}

impl GateExecution {
    pub fn new(run_id: &str, gate_index: i64, exit_code: Option<i64>, output: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            gate_index,
            exit_code,
            output_tail: tail(output, MAX_EVIDENCE_BYTES),
            recorded_at: Instant::now(),
        }
    }
}

/// `(session_id, tool_call_id)` → recorded execution, consumed once.
#[derive(Debug, Default)]
pub struct GateExecutions {
    entries: HashMap<(String, String), GateExecution>,
}

impl GateExecutions {
    pub fn record(&mut self, session_id: &str, tool_call_id: &str, execution: GateExecution) {
        if self.entries.len() >= MAX_PENDING_EXECUTIONS {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.recorded_at)
                .map(|(key, _)| key.clone());
            if let Some(key) = oldest {
                self.entries.remove(&key);
            }
        }
        self.entries.insert(
            (session_id.to_string(), tool_call_id.to_string()),
            execution,
        );
    }

    fn get(&self, session_id: &str, tool_call_id: &str) -> Option<&GateExecution> {
        self.entries
            .get(&(session_id.to_string(), tool_call_id.to_string()))
    }

    fn remove(&mut self, session_id: &str, tool_call_id: &str) {
        self.entries
            .remove(&(session_id.to_string(), tool_call_id.to_string()));
    }
}

struct OwnedRecord {
    gate_index: usize,
    action: &'static str,
    passed: Option<bool>,
    evidence: String,
    tool_call_id: Option<String>,
}

/// Evaluation of one stage visit: the outcome plus the gate rows to persist.
struct Evaluation {
    status: StageStatus,
    records: Vec<OwnedRecord>,
}

/// Count one failure of gate `index` and decide what it means.
fn fail(run: &mut ModeRun, index: usize, on_fail: &GateFailure, message: String) -> StageStatus {
    let key = format!("{}:{index}", run.stage_id);
    let count = run
        .retry_counts
        .get(&key)
        .copied()
        .unwrap_or(0)
        .saturating_add(1);
    run.retry_counts.insert(key, count);
    run.last_error = Some(tail(&message, MAX_EVIDENCE_BYTES));
    if count > on_fail.retries {
        run.set_waiting(WaitReason::Retries);
        return StageStatus::Blocked {
            message: format!("gate {index} failed {count} times: {message}"),
        };
    }
    if let Some(goto) = &on_fail.goto {
        run.enter_stage(goto);
        return StageStatus::Goto {
            next_stage_id: goto.clone(),
            message,
        };
    }
    StageStatus::Failed {
        gate_index: index as i64,
        message,
        retries_left: on_fail.retries + 1 - count,
    }
}

/// Evaluate the current stage's gates from `start`. Stops at the first
/// failure, `run` gate or `ask` gate; all passing leaves the stage.
fn evaluate_from(
    workspace: &Path,
    run: &mut ModeRun,
    definition: &ModeDefinition,
    start: usize,
    mut records: Vec<OwnedRecord>,
) -> Result<Evaluation> {
    let stage = definition
        .stage(&run.stage_id)
        .ok_or_else(|| mode_error_detail("MODE_SNAPSHOT_INVALID", "run stage is missing"))?
        .clone();
    for (index, gate) in stage.exit.iter().enumerate().skip(start) {
        match gate {
            ModeGate::Require { artifact, on_fail } => {
                let declared = definition.artifact(artifact);
                let relative = run.artifact_paths.get(artifact).cloned();
                let outcome = match (declared, relative) {
                    (Some(declared), Some(relative)) => artifacts::check_required(
                        workspace,
                        artifact,
                        &relative,
                        &declared.required_headings,
                    )?,
                    _ => Err(format!("artifact `{artifact}` is not declared")),
                };
                let passed = outcome.is_ok();
                records.push(OwnedRecord {
                    gate_index: index,
                    action: "require",
                    passed: Some(passed),
                    evidence: outcome.clone().err().unwrap_or_else(|| "present".into()),
                    tool_call_id: None,
                });
                if let Err(message) = outcome {
                    let status = fail(run, index, on_fail, message);
                    return Ok(Evaluation { status, records });
                }
            }
            ModeGate::Run {
                command,
                timeout_minutes,
                ..
            } => {
                run.pending_gate = Some(index as i64);
                return Ok(Evaluation {
                    status: StageStatus::Run {
                        gate_index: index as i64,
                        command: command.clone(),
                        timeout_minutes: *timeout_minutes,
                    },
                    records,
                });
            }
            ModeGate::Ask => {
                run.set_waiting(WaitReason::Approval);
                records.push(OwnedRecord {
                    gate_index: index,
                    action: "ask",
                    passed: None,
                    evidence: "awaiting approval".into(),
                    tool_call_id: None,
                });
                return Ok(Evaluation {
                    status: StageStatus::AwaitingApproval,
                    records,
                });
            }
        }
    }
    let status = match pass_transition(run, definition) {
        Transition::Advanced(next_stage_id) => StageStatus::Advanced { next_stage_id },
        Transition::Finished => StageStatus::Finished,
    };
    Ok(Evaluation { status, records })
}

fn persist(
    db: &Database,
    run: &mut ModeRun,
    definition: &ModeDefinition,
    stage_id: &str,
    records: &[OwnedRecord],
) -> Result<()> {
    let tx = db.conn().unchecked_transaction()?;
    for record in records {
        repository::record_gate(
            &tx,
            &run.id,
            GateRecord {
                stage_id,
                gate_index: record.gate_index,
                action: record.action,
                passed: record.passed,
                evidence: Some(&record.evidence),
                tool_call_id: record.tool_call_id.as_deref(),
            },
        )?;
    }
    repository::save(&tx, run)?;
    apply_finish(&tx, run, definition)?;
    tx.commit()?;
    Ok(())
}

fn claimed_run(
    db: &Database,
    session_id: &str,
    run_id: &str,
    turn_id: &str,
) -> Result<(ModeRun, ModeDefinition)> {
    let run = repository::owned(db.conn(), session_id, run_id)?;
    if run.state != RunState::Running || !run.claimed_by(turn_id) {
        return Err(mode_error("MODE_CLAIM_MISMATCH"));
    }
    let definition = snapshot::require(db.conn(), &run.snapshot_hash)?.definition;
    Ok((run, definition))
}

/// `modes.completeStage`: write the declared artifacts, then evaluate the
/// stage's exit gates from the first one.
pub fn complete_stage(
    db: &Database,
    workspace: &Path,
    params: CompleteStageParams,
) -> Result<StageOutcome> {
    if params.summary.len() > MAX_TEXT_BYTES {
        return Err(mode_error_detail(
            "MODE_INVALID_ARGUMENT",
            "summary is too long",
        ));
    }
    let (mut run, definition) =
        claimed_run(db, &params.session_id, &params.run_id, &params.turn_id)?;
    // The user edited the objective while this turn ran: its evidence is for
    // the old objective. The next claim carries the new one.
    if params
        .input
        .as_ref()
        .is_some_and(|input| *input != run.input)
    {
        return Err(mode_error("MODE_INPUT_CHANGED"));
    }
    if let Some(artifacts) = &params.artifacts {
        artifacts::write_declared(workspace, &run.artifact_paths, artifacts)?;
    }
    run.pending_gate = None;
    let stage_id = run.stage_id.clone();
    let evaluation = evaluate_from(workspace, &mut run, &definition, 0, Vec::new())?;
    persist(db, &mut run, &definition, &stage_id, &evaluation.records)?;
    Ok(StageOutcome {
        status: evaluation.status,
        run,
    })
}

/// `modes.gateResult`: consume the exit code of the pending `run` gate and
/// continue with the next gate, or apply the gate's failure handling.
pub fn gate_result(
    db: &Database,
    executions: &mut GateExecutions,
    workspace: &Path,
    params: GateResultParams,
) -> Result<StageOutcome> {
    let (mut run, definition) =
        claimed_run(db, &params.session_id, &params.run_id, &params.turn_id)?;
    if run.pending_gate != Some(params.gate_index) {
        return Err(mode_error("MODE_GATE_MISMATCH"));
    }
    let execution = executions
        .get(&params.session_id, &params.tool_call_id)
        .cloned()
        .ok_or_else(|| mode_error("MODE_GATE_RESULT_MISSING"))?;
    if execution.run_id != run.id || execution.gate_index != params.gate_index {
        return Err(mode_error("MODE_GATE_MISMATCH"));
    }
    let index = usize::try_from(params.gate_index).map_err(|_| mode_error("MODE_GATE_MISMATCH"))?;
    let stage_id = run.stage_id.clone();
    let (command, on_fail) = match definition
        .stage(&stage_id)
        .and_then(|stage| stage.exit.get(index))
    {
        Some(ModeGate::Run {
            command, on_fail, ..
        }) => (command.clone(), on_fail.clone()),
        _ => return Err(mode_error("MODE_GATE_MISMATCH")),
    };
    run.pending_gate = None;
    let passed = execution.exit_code == Some(0);
    let records = vec![OwnedRecord {
        gate_index: index,
        action: "run",
        passed: Some(passed),
        evidence: execution.output_tail.clone(),
        tool_call_id: Some(params.tool_call_id.clone()),
    }];
    let evaluation = if passed {
        evaluate_from(workspace, &mut run, &definition, index + 1, records)?
    } else {
        let code = execution
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "none (the command did not exit normally)".into());
        let message = format!(
            "`{command}` exited with code {code}\n{}",
            execution.output_tail
        );
        Evaluation {
            status: fail(&mut run, index, &on_fail, message),
            records,
        }
    };
    persist(db, &mut run, &definition, &stage_id, &evaluation.records)?;
    executions.remove(&params.session_id, &params.tool_call_id);
    Ok(StageOutcome {
        status: evaluation.status,
        run,
    })
}
