//! Internal batch metadata protocol. Registration grants neither permission nor
//! execution capacity and performs no filesystem lookup.
use super::*;
use crate::file_batches::BatchCall;
#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BatchAction {
    session_id: String,
    batch_id: Option<String>,
    ticket: Option<String>,
}

/// Approval/admission may await arbitrary user or tool work. Do not execute
/// against a root captured before that wait if its persisted binding changed.
pub(super) fn verify_root(
    state: &AppState,
    call: &ToolsExecuteParams,
    expected: Option<&str>,
) -> Result<bool, JsonRpcError> {
    if remote_tools::session_remote_workspace_optional(state, &call.session_id)?.is_some() {
        return Err(rpc_err(
            1002,
            "tool workspace changed during admission",
            "TOOL_CONTEXT_CHANGED",
        ));
    }
    let delegated = crate::session_worktrees::delegate::tool_root(
        &state.db,
        &call.session_id,
        call.delegation_id.as_deref(),
    )
    .map_err(worktree_rpc::to_rpc)?;
    let own = delegated.is_some();
    let current = match delegated {
        Some(path) => Some(path.to_string_lossy().into_owned()),
        None => resolve_tool_workspace_for_call(state, &call.session_id, &call.args)?,
    };
    if current.as_deref() != expected {
        return Err(rpc_err(
            1002,
            "tool workspace changed during admission",
            "TOOL_CONTEXT_CHANGED",
        ));
    }
    Ok(own)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    if method == "tools.fileBatchRegister" {
        let call: BatchCall = serde_json::from_value(params)
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
        let st = state.lock().await;
        if remote_tools::session_remote_workspace(&st, &call.session_id)?.is_some() {
            return Err(rpc_err(
                1002,
                "remote Host file batches are unavailable",
                "CAPABILITY_UNAVAILABLE",
            ));
        }
        let ticket = st
            .tool_budget
            .register_file_call(call)
            .map_err(|e| rpc_err(1002, e, "INVALID_PARAMS"))?;
        return Ok(json!({"ticket":ticket}));
    }
    let action: BatchAction = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    let st = state.lock().await;
    if method == "tools.fileBatchCapabilities" {
        let local = remote_tools::session_remote_workspace(&st, &action.session_id)?.is_none();
        return Ok(json!({"version":1,"supported":local}));
    }
    let result = match method {
        "tools.fileBatchSeal" => st.tool_budget.seal_file_batch(
            action
                .batch_id
                .as_deref()
                .ok_or_else(|| rpc_err(1002, "batchId required", "INVALID_PARAMS"))?,
            &action.session_id,
        ),
        "tools.fileBatchClose" => st.tool_budget.close_file_batch(
            action
                .batch_id
                .as_deref()
                .ok_or_else(|| rpc_err(1002, "batchId required", "INVALID_PARAMS"))?,
            &action.session_id,
        ),
        "tools.fileBatchAbandon" => st.tool_budget.abandon_file_call(
            action
                .ticket
                .as_deref()
                .ok_or_else(|| rpc_err(1002, "ticket required", "INVALID_PARAMS"))?,
            &action.session_id,
        ),
        _ => {
            return Err(rpc_err(
                -32601,
                "unknown file batch method",
                "METHOD_NOT_FOUND",
            ))
        }
    };
    result.map_err(|e| rpc_err(1002, e, "INVALID_PARAMS"))?;
    Ok(json!({"ok":true}))
}
