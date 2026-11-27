//! Session configuration and compare-before-write for LAN model selection.

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::JsonRpcError;
use super::{
    fast_mode_param, modes_rpc, plan_rpc_err, remote_tools, rpc_err, thinking_level_param,
};
use crate::{sessions, state::AppState};

/// The LAN edge has resolved the session and validated the requested model.
/// Recheck its scope and binding under the same Host lock as the write; a
/// concurrent Desktop change must never turn a model pick into a mode change.
fn check_model_precondition(
    st: &AppState,
    id: &str,
    mode: &str,
    params: &Value,
) -> Result<(), JsonRpcError> {
    let Some(expected) = params.get("expectedAgentModel") else {
        return Ok(());
    };
    if mode != "agent"
        || params.get("providerId").and_then(Value::as_str).is_none()
        || params.get("modelId").and_then(Value::as_str).is_none()
        || [
            "modeSnapshot",
            "permissionMode",
            "thinkingLevel",
            "fastMode",
        ]
        .iter()
        .any(|key| params.get(*key).is_some())
    {
        return Err(rpc_err(
            1002,
            "expectedAgentModel only guards a model change",
            "INVALID_PARAMS",
        ));
    }
    let current = sessions::session_summary(&st.db, id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "session not found", "NOT_FOUND"))?;
    let actual = json!({
        "projectPath": current.project_path,
        "providerId": current.provider_id,
        "modelId": current.model_id,
    });
    if current.mode != "agent"
        || current.scheduled_run
        || remote_tools::session_remote_workspace_optional(st, id)?.is_some()
        || expected != &actual
    {
        return Err(rpc_err(
            1008,
            "session configuration has changed",
            "CONFLICT",
        ));
    }
    Ok(())
}

pub(super) async fn configure(
    state: &Mutex<AppState>,
    tx: &mpsc::UnboundedSender<String>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "mode required", "INVALID_PARAMS"))?;
    let thinking_level = thinking_level_param(&params)?;
    let fast_mode = fast_mode_param(&params)?;
    let st = state.lock().await;
    check_model_precondition(&st, id, mode, &params)?;
    let prepared = modes_rpc::prepare_configure(&st, id, mode, &params)?;
    let session = sessions::configure_session_with_mode_snapshot(
        &st.db,
        id,
        mode,
        params.get("providerId").and_then(Value::as_str),
        params.get("modelId").and_then(Value::as_str),
        thinking_level.as_deref(),
        params.get("permissionMode").and_then(Value::as_str),
        fast_mode,
        prepared.snapshot_hash(),
    )
    .map_err(|e| {
        let message = e.to_string();
        if message.starts_with("PLAN_") {
            plan_rpc_err(message)
        } else {
            rpc_err(1002, message, "INVALID_PARAMS")
        }
    })?
    .ok_or_else(|| rpc_err(1007, "session not found", "NOT_FOUND"))?;
    let paused_run = modes_rpc::finish_configure(&st, prepared)?;
    let session = remote_tools::decorate_session(
        &st.db,
        serde_json::to_value(session).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?,
    )?;
    drop(st);
    if let Some(run) = paused_run {
        modes_rpc::notify(tx, &run).await;
    }
    Ok(json!({ "session": session }))
}
