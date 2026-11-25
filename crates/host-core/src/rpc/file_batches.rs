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

/// Use the same persisted root before permission and after admission. For a
/// scoped call, an absent delegate worktree cannot fall back to a different
/// checkout, and a target path cannot choose a different base for the scope.
pub(super) fn resolve_root(
    state: &AppState,
    call: &ToolsExecuteParams,
) -> Result<(Option<String>, bool), JsonRpcError> {
    let delegated = if call.write_scope.is_some() {
        crate::session_worktrees::delegate::scoped_tool_root(
            &state.db,
            &call.session_id,
            call.delegation_id.as_deref(),
        )
    } else {
        crate::session_worktrees::delegate::tool_root(
            &state.db,
            &call.session_id,
            call.delegation_id.as_deref(),
        )
    }
    .map_err(worktree_rpc::to_rpc)?;
    if let Some(path) = delegated {
        return Ok((Some(path.to_string_lossy().into_owned()), true));
    }
    let root = if call.write_scope.is_some() {
        // Unlike the ordinary resolver this does not create scratch, or use
        // args.path to choose a secondary root in the logical project group.
        let summary = sessions::session_summary(&state.db, &call.session_id)
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
            .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
        Some(summary.project_path.ok_or_else(|| {
            rpc_err(
                1003,
                "A scoped write requires a local project workspace",
                "WORKSPACE_REQUIRED",
            )
        })?)
    } else {
        resolve_tool_workspace_for_call(state, &call.session_id, &call.args)?
    };
    Ok((root, false))
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
    let (current, own) = resolve_root(state, call)?;
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
