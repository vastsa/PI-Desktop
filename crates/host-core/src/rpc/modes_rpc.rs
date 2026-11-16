//! Thin adapter for staged mode runs (ADR mode-definitions): `modes.*`
//! methods, the `session.configure` mode snapshot, and the `tools.execute`
//! gate-command hooks. The run engine lives in `crate::mode_runs`.
//!
//! Adapter shape ported from PR #2141 by new-Beginner (`rpc/goals_rpc.rs`).

use std::path::PathBuf;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::{emit_notification, remote_tools, resolve_tool_workspace, rpc_err, JsonRpcError};
use crate::mode_runs::{self, GateExecution, ModeRun, PreparedMode, SessionParams};
use crate::state::AppState;
use crate::tools::ToolsExecuteParams;

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(value)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))
}

/// `MODE_*` failures keep their code as the wire `errorCode`; anything else
/// is an internal error.
pub(super) fn error(error: anyhow::Error) -> JsonRpcError {
    let message = error.to_string();
    let code = message.split(':').next().unwrap_or_default().trim();
    if code.starts_with("MODE_") && code.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_') {
        let rpc_code = if code.ends_with("_NOT_FOUND") {
            1007
        } else {
            1002
        };
        let code = code.to_string();
        rpc_err(rpc_code, message, &code)
    } else {
        rpc_err(1000, message, "INTERNAL")
    }
}

fn run_value(run: Option<&ModeRun>) -> Value {
    run.map(ModeRun::wire).unwrap_or(Value::Null)
}

/// `modes.changed { sessionId, run }` after a committed change.
pub(super) async fn notify(tx: &mpsc::UnboundedSender<String>, run: &ModeRun) {
    emit_notification(
        tx,
        "modes.changed",
        json!({ "sessionId": run.session_id, "run": run.wire() }),
    )
    .await;
}

/// Local workspace root the run's artifacts live under. Staged runs are not
/// supported on remote workspaces in v1.
fn local_workspace(st: &AppState, session_id: &str) -> Result<PathBuf, JsonRpcError> {
    if remote_tools::session_remote_workspace_optional(st, session_id)?.is_some() {
        return Err(rpc_err(
            1002,
            "staged modes are not supported on remote workspaces",
            "MODE_REMOTE_UNSUPPORTED",
        ));
    }
    resolve_tool_workspace(st, session_id)?
        .map(PathBuf::from)
        .ok_or_else(|| rpc_err(1002, "session has no workspace", "MODE_REMOTE_UNSUPPORTED"))
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let mut guard = state.lock().await;
    let st = &mut *guard;
    let (response, changed) = match method {
        "modes.get" => {
            let p: SessionParams = parse(params)?;
            let run = mode_runs::open_run(&st.db, &p.session_id).map_err(error)?;
            return Ok(json!({ "run": run_value(run.as_ref()) }));
        }
        "modes.start" | "modes.startGoal" => {
            let p: mode_runs::StartParams = parse(params.clone())?;
            let workspace = local_workspace(st, &p.session_id)?;
            let result = if method == "modes.startGoal" {
                let value = params
                    .get("modeSnapshot")
                    .ok_or_else(|| error(crate::mode_runs::mode_error("MODE_SNAPSHOT_REQUIRED")))?;
                mode_runs::start_goal(&st.db, &workspace, p, value)
            } else {
                mode_runs::start(&st.db, &workspace, p)
            }
            .map_err(error)?;
            (result.wire(), result.changed.then_some(result.run))
        }
        "modes.resetGoalInput" => {
            let p: SessionParams = parse(params)?;
            mode_runs::reset_goal_input(&st.db, &p.session_id).map_err(error)?;
            return Ok(json!({ "ok": true }));
        }
        "modes.claimTurn" => {
            let result = mode_runs::claim_turn(&st.db, parse(params)?).map_err(error)?;
            (result.wire(), result.changed.then_some(result.run))
        }
        "modes.completeStage" => {
            let p: mode_runs::CompleteStageParams = parse(params)?;
            let workspace = local_workspace(st, &p.session_id)?;
            let outcome = mode_runs::complete_stage(&st.db, &workspace, p).map_err(error)?;
            (outcome.wire(), Some(outcome.run))
        }
        "modes.gateResult" => {
            let p: mode_runs::GateResultParams = parse(params)?;
            let workspace = local_workspace(st, &p.session_id)?;
            let outcome =
                mode_runs::gate_result(&st.db, &mut st.mode_gate_executions, &workspace, p)
                    .map_err(error)?;
            (outcome.wire(), Some(outcome.run))
        }
        "modes.settleTurn" => {
            let result = mode_runs::settle_turn(&st.db, parse(params)?).map_err(error)?;
            (result.wire(), result.changed.then_some(result.run))
        }
        "modes.control" => {
            let result = mode_runs::control(&st.db, parse(params)?).map_err(error)?;
            (result.wire(), result.changed.then_some(result.run))
        }
        "modes.update" => {
            let result = mode_runs::update(&st.db, parse(params)?).map_err(error)?;
            (result.wire(), result.changed.then_some(result.run))
        }
        "modes.settleReturn" => {
            let result = mode_runs::settle_return(&st.db, parse(params)?).map_err(error)?;
            return Ok(result.wire());
        }
        "modes.resolve" => {
            let result = mode_runs::resolve(&st.db, parse(params)?).map_err(error)?;
            (result.wire(), result.changed.then_some(result.run))
        }
        _ => {
            return Err(rpc_err(
                -32601,
                format!("method not found: {method}"),
                "NOT_FOUND",
            ))
        }
    };
    drop(guard);
    if let Some(run) = changed {
        notify(tx, &run).await;
    }
    Ok(response)
}

/// Validate `session.configure`'s mode and optional `modeSnapshot`, and
/// store the snapshot so the session row can reference it.
pub(super) fn prepare_configure(
    st: &AppState,
    session_id: &str,
    mode: &str,
    params: &Value,
) -> Result<PreparedMode, JsonRpcError> {
    let prepared =
        mode_runs::prepare_session_mode(&st.db, session_id, mode, params.get("modeSnapshot"))
            .map_err(error)?;
    mode_runs::store_session_snapshot(&st.db, &prepared).map_err(error)?;
    Ok(prepared)
}

/// After the session row changed: pause a run whose mode the session left.
/// Returns the run to announce.
pub(super) fn finish_configure(
    st: &AppState,
    prepared: PreparedMode,
) -> Result<Option<ModeRun>, JsonRpcError> {
    mode_runs::configure_session_mode(&st.db, prepared).map_err(error)
}

/// Legacy Goal negotiation is closed to new work; the staged builtin Goal
/// replaces it. Existing goal approvals stay readable and resolvable.
pub(super) fn reject_goal_activation(kind: &str) -> Result<(), JsonRpcError> {
    if kind == crate::plans::KIND_GOAL {
        return Err(rpc_err(
            1015,
            "PLAN_GOAL_ACTIVATION_DISABLED: Goal now runs as a staged mode",
            "PLAN_GOAL_ACTIVATION_DISABLED",
        ));
    }
    Ok(())
}

fn gate_mismatch() -> JsonRpcError {
    rpc_err(1002, "MODE_GATE_MISMATCH", "MODE_GATE_MISMATCH")
}

/// A `tools.execute` call that carries `modeGate` must be exactly the
/// pending gate's command, run in the foreground of a local Bash.
pub(super) fn verify_gate_call(
    st: &AppState,
    p: &ToolsExecuteParams,
    remote: bool,
) -> Result<(), JsonRpcError> {
    let Some(gate) = p.mode_gate.as_ref() else {
        return Ok(());
    };
    if p.tool_name != "Bash" || p.run_in_background || remote {
        return Err(gate_mismatch());
    }
    let command = p
        .args
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(gate_mismatch)?;
    mode_runs::verify_gate_command(
        &st.db,
        &p.session_id,
        p.turn_id.as_deref(),
        &gate.run_id,
        gate.gate_index,
        command,
    )
    .map_err(|_| gate_mismatch())
}

/// Remember the gate command's exit code for `modes.gateResult`.
pub(super) async fn record_gate_call(
    state: &Arc<Mutex<AppState>>,
    p: &ToolsExecuteParams,
    outcome: &Result<Value, JsonRpcError>,
) {
    let Some(gate) = p.mode_gate.as_ref() else {
        return;
    };
    let (exit_code, output) = match outcome {
        Ok(result) => {
            let content = &result["content"];
            let exit_code = content.get("exitCode").and_then(Value::as_i64);
            let mut output = String::new();
            for key in ["stdout", "stderr", "error"] {
                if let Some(text) = content.get(key).and_then(Value::as_str) {
                    if !text.is_empty() {
                        if !output.is_empty() {
                            output.push('\n');
                        }
                        output.push_str(text);
                    }
                }
            }
            (exit_code, output)
        }
        Err(error) => (None, error.message.clone()),
    };
    let mut st = state.lock().await;
    st.mode_gate_executions.record(
        &p.session_id,
        &p.tool_call_id,
        GateExecution::new(&gate.run_id, gate.gate_index, exit_code, &output),
    );
}

#[cfg(test)]
#[path = "modes_rpc_tests.rs"]
mod tests;
