//! Remote workspace bindings preserve local sessions, approvals and model state.
//! Only admitted tool bodies cross to the paired host; no local runner fallback.
use super::*;
use crate::db::{Database, RemoteWorkspace};

fn remote_workspace_of(
    state: &AppState,
    summary: &sessions::SessionSummary,
) -> Result<Option<RemoteWorkspace>, JsonRpcError> {
    summary
        .project_path
        .as_deref()
        .map(|path| state.db.remote_workspace_for_path(path))
        .transpose()
        .map(Option::flatten)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

/// The remote binding of a session that must exist.
pub(super) fn session_remote_workspace(
    state: &AppState,
    session_id: &str,
) -> Result<Option<RemoteWorkspace>, JsonRpcError> {
    let summary = sessions::session_summary(&state.db, session_id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
    remote_workspace_of(state, &summary)
}

/// `tools.execute` is reachable for a session the store does not have yet, and
/// that path owns its own tool-level failure. A missing session therefore means
/// "no remote binding" instead of an RPC error, so the local tool path stays
/// exactly as it was before remote workspaces existed.
pub(super) fn session_remote_workspace_optional(
    state: &AppState,
    session_id: &str,
) -> Result<Option<RemoteWorkspace>, JsonRpcError> {
    match sessions::session_summary(&state.db, session_id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
    {
        Some(summary) => remote_workspace_of(state, &summary),
        None => Ok(None),
    }
}

pub(super) fn decorate_session(db: &Database, mut value: Value) -> Result<Value, JsonRpcError> {
    if let Some(path) = value.get("projectPath").and_then(Value::as_str) {
        if let Some(remote) = db
            .remote_workspace_for_path(path)
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?
        {
            value["remoteWorkspace"] = json!(remote);
        }
    }
    Ok(value)
}
pub(super) fn session_value(
    db: &Database,
    summary: sessions::SessionSummary,
) -> Result<Value, JsonRpcError> {
    decorate_session(
        db,
        serde_json::to_value(summary).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?,
    )
}

pub(super) fn requires_external_permission(
    root: Option<&str>,
    tool_name: &str,
    args: &Value,
) -> bool {
    matches!(tool_name, "Read" | "Glob" | "Grep" | "Write" | "Edit")
        && args
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| {
                root.is_some_and(|root| {
                    let candidate = if Path::new(path).is_absolute() {
                        PathBuf::from(path)
                    } else {
                        Path::new(root).join(path)
                    };
                    !workspace::lexically_inside(Path::new(root), &candidate.to_string_lossy())
                })
            })
}

fn failure(
    p: &ToolsExecuteParams,
    code: &str,
    message: &str,
    started: std::time::Instant,
) -> tools::ToolsExecuteResult {
    tools::ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: false,
        is_error: Some(true),
        content: json!({"error": message, "code": code}),
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code: Some(code.into()),
        command_shell_id: None,
    }
}

pub(super) async fn execute_remote_tool(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    p: &ToolsExecuteParams,
    remote: RemoteWorkspace,
    mut cancellation: Option<tokio::sync::watch::Receiver<bool>>,
) -> tools::ToolsExecuteResult {
    let started = std::time::Instant::now();
    if !matches!(
        p.tool_name.as_str(),
        "Read" | "Glob" | "Grep" | "Write" | "Edit" | "Bash"
    ) {
        return failure(
            p,
            "CAPABILITY_UNAVAILABLE",
            "tool is unavailable for a remote workspace",
            started,
        );
    }
    if tool_cancellation_requested(&cancellation) {
        return failure(p, "TOOL_ABORTED", "tool aborted", started);
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state
        .lock()
        .await
        .remote_execs
        .insert(request_id.clone(), sender);
    emit_notification(
        tx,
        "tools.remoteExecute",
        json!({
            "requestId": request_id, "sessionId": p.session_id, "turnId": p.turn_id,
            "toolCallId": p.tool_call_id, "toolName": p.tool_name, "args": p.args,
            "remoteWorkspace": remote, "timeoutMs": p.timeout_ms,
            "expectedCommandShellId": p.expected_command_shell_id,
            "expectedCommandShellDialect": p.expected_command_shell_dialect,
        }),
    )
    .await;
    let timeout_ms = tools::effective_timeout_ms(&p.tool_name, p.timeout_ms).unwrap_or(120_000);
    let outcome = tokio::select! {
        outcome = tokio::time::timeout(Duration::from_millis(timeout_ms.saturating_add(15_000)), receiver) => match outcome {
            Ok(Ok(value)) => Ok(value), _ => Err("TOOL_TIMEOUT"),
        },
        _ = wait_for_tool_cancellation(&mut cancellation) => Err("TOOL_ABORTED"),
    };
    state.lock().await.remote_execs.remove(&request_id);
    match outcome {
        Ok(value) => {
            let Some(ok) = value.get("ok").and_then(Value::as_bool) else {
                return failure(
                    p,
                    "INVALID_REMOTE_RESULT",
                    "remote tool result is invalid",
                    started,
                );
            };
            let Some(content) = value.get("content").cloned() else {
                return failure(
                    p,
                    "INVALID_REMOTE_RESULT",
                    "remote tool content is missing",
                    started,
                );
            };
            tools::ToolsExecuteResult {
                tool_call_id: p.tool_call_id.clone(),
                ok,
                is_error: if ok { None } else { Some(true) },
                content,
                duration_ms: started.elapsed().as_millis() as u64,
                denied: None,
                error_code: if ok {
                    None
                } else {
                    Some(
                        value
                            .get("errorCode")
                            .and_then(Value::as_str)
                            .unwrap_or("TOOL_FAILED")
                            .into(),
                    )
                },
                command_shell_id: value
                    .get("commandShellId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }
        }
        Err(code) => {
            send_notification(
                tx,
                "tools.remoteAbort",
                json!({"sessionId":p.session_id,"toolCallId":p.tool_call_id}),
            );
            failure(
                p,
                code,
                if code == "TOOL_ABORTED" {
                    "tool aborted"
                } else {
                    "remote tool timed out or disconnected"
                },
                started,
            )
        }
    }
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    if method == "tools.remoteComplete" {
        let id = params
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| rpc_err(1002, "requestId required", "INVALID_PARAMS"))?;
        let result = params
            .get("result")
            .cloned()
            .ok_or_else(|| rpc_err(1002, "result required", "INVALID_PARAMS"))?;
        let sender = state
            .lock()
            .await
            .remote_execs
            .remove(id)
            .ok_or_else(|| rpc_err(1007, "remote tool request not found", "NOT_FOUND"))?;
        let _ = sender.send(result);
        return Ok(json!({"ok":true}));
    }
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
    let tool_call_id = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
    if method == "tools.workspaceAbort" {
        let (found, queued) = state
            .lock()
            .await
            .abort_or_queue_bash(session_id, tool_call_id);
        return Ok(json!({"ok":true,"found":found,"queued":queued,"aborted":found||queued}));
    }
    let raw_path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
    if !Path::new(raw_path).is_absolute()
        || raw_path.len() > 4096
        || raw_path.chars().any(char::is_control)
    {
        return Err(rpc_err(1002, "invalid workspace path", "INVALID_PARAMS"));
    }
    let root = workspace::simple_canonicalize(Path::new(raw_path))
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    if !root.is_dir() {
        return Err(rpc_err(
            1002,
            "workspace must be a directory",
            "INVALID_PARAMS",
        ));
    }
    let mut input = params.clone();
    input["mode"] = json!("agent");
    let p: ToolsExecuteParams = serde_json::from_value(input)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    let started = std::time::Instant::now();
    if !matches!(
        p.tool_name.as_str(),
        "Read" | "Glob" | "Grep" | "Write" | "Edit" | "Bash"
    ) {
        return serde_json::to_value(failure(
            &p,
            "CAPABILITY_UNAVAILABLE",
            "remote runner tool unavailable",
            started,
        ))
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
    }
    tools::validate_timeout_ms(p.timeout_ms)
        .map_err(|(code, message)| rpc_err(1002, message, &code))?;
    let (mut cancellation, hashline, shell) = {
        let mut st = state.lock().await;
        let shell = if p.tool_name == "Bash" {
            let catalog = command_shell_catalog(&st)?;
            let shell = catalog
                .effective
                .ok_or_else(|| rpc_err(1002, "command shell unavailable", "SHELL_NOT_FOUND"))?;
            if p.expected_command_shell_id.as_deref() != Some(shell.id.as_str())
                || p.expected_command_shell_dialect.as_deref() != Some(shell.dialect.as_str())
            {
                return serde_json::to_value(shell_changed_result(
                    &p,
                    p.expected_command_shell_id.as_deref().unwrap_or(""),
                    p.expected_command_shell_dialect.as_deref(),
                    Some(shell.id.clone()),
                    Some(shell.dialect.as_str()),
                    started,
                ))
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
            }
            shell.id
        } else {
            String::new()
        };
        let cancellation = st
            .register_bash_cancellation(&p.session_id, &p.tool_call_id)
            .map_err(|code| rpc_err(1008, "tool already executing", &code))?;
        (Some(cancellation), st.hashline.clone(), shell)
    };
    if tool_cancellation_requested(&cancellation) {
        state
            .lock()
            .await
            .clear_bash_cancellation(&p.session_id, &p.tool_call_id);
        return serde_json::to_value(failure(&p, "TOOL_ABORTED", "tool aborted", started))
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
    }
    let options = tools::ToolExecutionOptions {
        timeout_ms: tools::effective_timeout_ms(&p.tool_name, p.timeout_ms),
        bash_options: if p.tool_name == "Bash" {
            Some(tools::BashExecutionOptions {
                session_id: p.session_id.clone(),
                tool_call_id: p.tool_call_id.clone(),
                command_shell_id: shell,
                timeout_ms: tools::effective_timeout_ms(&p.tool_name, p.timeout_ms),
                cancellation: cancellation.clone(),
                output_tx: Some(tx),
                // Remote workspaces are never isolated (ADR 0329).
                extra_env: Vec::new(),
                run_in_background: false,
                app_state: None,
            })
        } else {
            None
        },
        allow_external_paths: false,
        hashline: Some(tools::HashlineContext {
            session_id: &p.session_id,
            store: &hashline,
        }),
        visualization_root: None,
    };
    let mut result = tokio::select! {
        result = tools::execute_tool_with_path_access(Some(&root),None,&p.tool_name,&p.args,options) => result,
        _ = wait_for_tool_cancellation(&mut cancellation) => failure(&p,"TOOL_ABORTED","tool aborted",started),
    };
    result.tool_call_id = p.tool_call_id.clone();
    state
        .lock()
        .await
        .clear_bash_cancellation(&p.session_id, &p.tool_call_id);
    serde_json::to_value(result).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
}

#[cfg(test)]
#[path = "remote_tools_tests.rs"]
mod tests;
