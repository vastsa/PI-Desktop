use std::io::{self, BufRead, BufReader as StdBufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};

use crate::agent_capabilities::CapabilityLevel;
use crate::artifacts;
use crate::audit;
use crate::notifications;
use crate::permissions::{PermissionDecision, PermissionManager};
use crate::plans;
use crate::providers::{self, DiscoveredModelInput, ProviderCreateInput, ProviderUpdateInput};
use crate::review;
use crate::scheduled;
use crate::scratch;
use crate::sessions::{self, UiMessage};
use crate::state::{AppState, HOST_VERSION, PROTOCOL_VERSION};
use crate::tools::{self, ToolsExecuteParams};
use crate::transcripts::CompactionRecord;
use crate::workspace;

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification {
    jsonrpc: &'static str,
    method: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheModelsParams {
    provider_id: String,
    models: Vec<DiscoveredModelInput>,
}

#[derive(Debug)]
enum StdinEvent {
    Line(String),
    Error(String),
}

/// Tokio's stdio adapter delegates every read/write to the blocking pool. If
/// the OS temporarily refuses another worker thread, Tokio panics instead of
/// returning an error. The host's control pipe must not share that failure
/// mode, so it uses two fixed, explicitly named threads instead.
fn is_transient_io_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
    ) || matches!(error.raw_os_error(), Some(11) | Some(35))
}

fn spawn_stdin_reader(tx: mpsc::UnboundedSender<StdinEvent>) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("pi-host-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut reader = StdBufReader::new(stdin.lock());
            let mut line = String::new();

            loop {
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if tx
                            .send(StdinEvent::Line(std::mem::take(&mut line)))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if is_transient_io_error(&error) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => {
                        let _ = tx.send(StdinEvent::Error(error.to_string()));
                        break;
                    }
                }
            }
        })
}

fn write_stdout_message(writer: &mut impl Write, message: &str) -> io::Result<()> {
    let bytes = message.as_bytes();
    let mut offset = 0;

    while offset < bytes.len() {
        match writer.write(&bytes[offset..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "stdout writer made no progress",
                ));
            }
            Ok(written) => offset += written,
            Err(error) if is_transient_io_error(&error) => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }

    loop {
        match writer.flush() {
            Ok(()) => return Ok(()),
            Err(error) if is_transient_io_error(&error) => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
}

fn spawn_stdout_writer(
    mut rx: mpsc::UnboundedReceiver<String>,
    done_tx: oneshot::Sender<Option<String>>,
) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("pi-host-stdout".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut writer = stdout.lock();
            let mut writer_error = None;

            while let Some(message) = rx.blocking_recv() {
                if let Err(error) = write_stdout_message(&mut writer, &message) {
                    writer_error = Some(error.to_string());
                    break;
                }
            }

            let _ = done_tx.send(writer_error);
        })
}

pub async fn serve(state: Arc<Mutex<AppState>>) -> Result<()> {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    // Keep request tasks bounded as well as tool executions. Tool calls have
    // their own class/session budgets below; this cap protects the host from
    // non-tool RPC bursts and prevents an unbounded tokio task fan-out.
    const MAX_IN_FLIGHT_RPC: usize = 32;
    let request_slots = Arc::new(Semaphore::new(MAX_IN_FLIGHT_RPC));
    let mut request_tasks = tokio::task::JoinSet::new();

    // Keep stdio off Tokio's blocking pool. Under process/thread pressure,
    // Tokio's stdio adapter can panic while trying to create a worker thread;
    // these two dedicated threads instead report startup errors or stop on a
    // closed pipe without taking down the async request dispatcher.
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<Option<String>>();
    let _writer = spawn_stdout_writer(rx, writer_done_tx)
        .map_err(|error| anyhow!("host stdout writer unavailable: {error}"))?;
    // Electron's RegisterHotKey cannot claim Windows' Alt+Space system-menu
    // chord. Keep the native fallback beside the host transport so it remains
    // active even when PI-Desktop is unfocused.
    crate::keyboard::start(tx.clone());
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<StdinEvent>();
    let _stdin_reader = match spawn_stdin_reader(input_tx) {
        Ok(handle) => handle,
        Err(error) => {
            drop(tx);
            let _ = writer_done_rx.await;
            return Err(anyhow!("host stdin reader unavailable: {error}"));
        }
    };

    let mut input_error = None;
    let mut writer_done = false;
    'serve: loop {
        tokio::select! {
            event = input_rx.recv() => {
                let Some(event) = event else {
                    break 'serve;
                };
                let line = match event {
                    StdinEvent::Line(line) => line,
                    StdinEvent::Error(error) => {
                        input_error = Some(format!("host stdin read failed: {error}"));
                        break 'serve;
                    }
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue 'serve;
                }

                let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
                    Ok(r) => r,
                    Err(e) => {
                        let resp = JsonRpcResponse {
                            jsonrpc: "2.0",
                            id: Value::Null,
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32700,
                                message: format!("parse error: {e}"),
                                data: None,
                            }),
                        };
                        let _ = tx.send(format!("{}\n", serde_json::to_string(&resp)?));
                        continue 'serve;
                    }
                };

                if req.id.is_none() {
                    continue 'serve;
                }

                let id = req.id.clone().unwrap_or(Value::Null);
                let method = req.method.clone();
                let params = req.params.unwrap_or(json!({}));
                let state = state.clone();
                let tx = tx.clone();
                let permit = match request_slots.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let response = JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(rpc_err(
                                -32029,
                                "host RPC capacity is exhausted",
                                "HOST_OVERLOADED",
                            )),
                        };
                        if let Ok(raw) = serde_json::to_string(&response) {
                            let _ = tx.send(format!("{raw}\n"));
                        }
                        continue 'serve;
                    }
                };

                request_tasks.spawn(async move {
                    let _permit = permit;
                    let out = match handle_request(state, &method, params, tx.clone()).await {
                        Ok(result) => JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: Some(result),
                            error: None,
                        },
                        Err(err) => JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(err),
                        },
                    };
                    if let Ok(raw) = serde_json::to_string(&out) {
                        let _ = tx.send(format!("{raw}\n"));
                    }
                });
            }
            result = &mut writer_done_rx => {
                writer_done = true;
                input_error = match result {
                    Ok(Some(error)) => Some(format!("host stdout write failed: {error}")),
                    Ok(None) => Some("host stdout writer stopped".to_string()),
                    Err(_) => Some("host stdout writer status unavailable".to_string()),
                };
                break 'serve;
            }
            completed = request_tasks.join_next(), if !request_tasks.is_empty() => {
                if let Some(Err(error)) = completed {
                    tracing::warn!(error = %error, "RPC request task failed");
                }
            }
        }
    }

    {
        let mut st = state.lock().await;
        st.shutdown();
    }
    while let Some(result) = request_tasks.join_next().await {
        if let Err(error) = result {
            tracing::warn!(error = %error, "RPC request task failed during shutdown");
        }
    }
    drop(tx);
    if !writer_done {
        input_error = match writer_done_rx.await {
            Ok(Some(error)) => Some(format!("host stdout write failed: {error}")),
            Ok(None) => input_error,
            Err(_) => Some("host stdout writer status unavailable".to_string()),
        };
    }
    input_error
        .map(|error| Err(anyhow!("{error}")))
        .unwrap_or(Ok(()))
}

fn rpc_err(code: i64, message: impl Into<String>, error_code: &str) -> JsonRpcError {
    JsonRpcError {
        code,
        message: message.into(),
        data: Some(json!({ "errorCode": error_code })),
    }
}

/// JSON-RPC numeric code used for every A2A domain error; the contract
/// discriminator is the `errorCode` string carried in `data`.
const A2A_JSONRPC_CODE: i64 = 1400;

/// Map a broker [`crate::a2a::A2aError`] to a JSON-RPC error carrying its
/// contract error-code string (e.g. "A2A_UNKNOWN_TOKEN").
fn a2a_err(error: crate::a2a::A2aError) -> JsonRpcError {
    rpc_err(A2A_JSONRPC_CODE, error.message(), error.code())
}

/// Parse `a2a.*` params into their typed struct at the RPC boundary.
fn a2a_params<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(params).map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))
}

/// Parse the optional session thinking selector at the RPC boundary.  A
/// missing/null value keeps the backwards-compatible default; present values
/// must be strings from the host's allowlist rather than being silently
/// coerced to `off`.
fn thinking_level_param(params: &Value) -> Result<Option<String>, JsonRpcError> {
    let Some(value) = params.get("thinkingLevel") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(level) = value.as_str() else {
        return Err(rpc_err(
            1002,
            "thinkingLevel must be a string",
            "INVALID_PARAMS",
        ));
    };
    if !sessions::is_valid_thinking_level(level) {
        return Err(rpc_err(
            1002,
            format!(
                "thinkingLevel must be one of {}",
                sessions::THINKING_LEVELS.join(", ")
            ),
            "INVALID_PARAMS",
        ));
    }
    Ok(Some(level.to_string()))
}

const DEFAULT_LARGE_PASTE_THRESHOLD: i64 = 600;
const MIN_LARGE_PASTE_THRESHOLD: i64 = 1;
const MAX_LARGE_PASTE_THRESHOLD: i64 = 1_000_000;

fn normalize_settings_value(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("planApprovalPermissionMode");
        if object.get("defaultMode").and_then(Value::as_str) == Some("chat") {
            object.insert("defaultMode".into(), Value::String("plan".into()));
        }
        let valid_command_shell = object
            .get("defaultCommandShell")
            .and_then(Value::as_str)
            .is_some_and(tools::shell::is_known_shell_id);
        if !valid_command_shell {
            object.insert(
                "defaultCommandShell".into(),
                Value::String(tools::shell::default_shell_id().into()),
            );
        }
        let valid_large_paste_threshold = object
            .get("largePasteThreshold")
            .and_then(Value::as_i64)
            .is_some_and(|threshold| {
                (MIN_LARGE_PASTE_THRESHOLD..=MAX_LARGE_PASTE_THRESHOLD).contains(&threshold)
            });
        if !valid_large_paste_threshold {
            object.insert(
                "largePasteThreshold".into(),
                Value::Number(DEFAULT_LARGE_PASTE_THRESHOLD.into()),
            );
        }
    }
    value
}

fn merge_settings_value(stored: Option<Value>, incoming: Value) -> Value {
    let Value::Object(incoming) = incoming else {
        return incoming;
    };
    let mut merged = match stored {
        Some(Value::Object(object)) => object,
        _ => serde_json::Map::new(),
    };
    merged.extend(incoming);
    Value::Object(merged)
}

fn effective_command_shell_id(settings: Option<&Value>) -> Option<String> {
    let configured = settings
        .and_then(|value| value.get("defaultCommandShell"))
        .and_then(Value::as_str);
    tools::shell::catalog(configured)
        .effective
        .map(|shell| shell.id)
}

fn validate_settings_value(value: &Value) -> Result<(), JsonRpcError> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if let Some(threshold_value) = object.get("largePasteThreshold") {
        let Some(threshold) = threshold_value.as_i64() else {
            return Err(rpc_err(
                1002,
                "largePasteThreshold must be an integer",
                "INVALID_PARAMS",
            ));
        };
        if !(MIN_LARGE_PASTE_THRESHOLD..=MAX_LARGE_PASTE_THRESHOLD).contains(&threshold) {
            return Err(rpc_err(
                1002,
                format!(
                    "largePasteThreshold must be between {MIN_LARGE_PASTE_THRESHOLD} and {MAX_LARGE_PASTE_THRESHOLD}"
                ),
                "INVALID_PARAMS",
            ));
        }
    }
    let Some(shell_value) = object.get("defaultCommandShell") else {
        return Ok(());
    };
    let Some(shell_id) = shell_value.as_str() else {
        return Err(rpc_err(
            1002,
            "defaultCommandShell must be a supported command shell ID",
            "COMMAND_SHELL_INVALID",
        ));
    };
    if !tools::shell::is_known_shell_id(shell_id) {
        return Err(rpc_err(
            1002,
            format!("unknown command shell ID '{shell_id}'"),
            "COMMAND_SHELL_INVALID",
        ));
    }
    let catalog = tools::shell::catalog(None);
    if !catalog
        .choices
        .iter()
        .any(|choice| choice.id == shell_id && choice.available)
    {
        return Err(rpc_err(
            1002,
            format!("command shell ID '{shell_id}' is unavailable on this platform"),
            "COMMAND_SHELL_INVALID",
        ));
    }
    Ok(())
}

fn gate_default_command_shell_setting(state: &AppState) -> Result<(), JsonRpcError> {
    plans::expire_pending_approvals(&state.db)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let blocked: bool = state
        .db
        .conn()
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM turns WHERE status = 'running'
             ) OR EXISTS(
                 SELECT 1 FROM plan_approvals WHERE status = 'pending'
             ) OR EXISTS(
                 SELECT 1 FROM plan_approvals
                 WHERE execution_state IN ('queued', 'running')
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    if blocked {
        return Err(rpc_err(
            1008,
            "defaultCommandShell can only change while all sessions are idle",
            "PLAN_CONFIGURATION_BLOCKED",
        ));
    }
    Ok(())
}

fn command_shell_catalog(state: &AppState) -> Result<tools::shell::ShellCatalog, JsonRpcError> {
    let settings = state
        .db
        .get_setting("app")
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .unwrap_or_else(|| json!({}));
    let configured_id = settings.get("defaultCommandShell").and_then(Value::as_str);
    Ok(tools::shell::catalog(configured_id))
}

fn shell_failure_result(
    p: &ToolsExecuteParams,
    error_code: &str,
    message: impl Into<String>,
    command_shell_id: Option<String>,
    started: std::time::Instant,
) -> tools::ToolsExecuteResult {
    let message = message.into();
    let mut content = json!({ "error": message, "code": error_code });
    if let Some(shell_id) = command_shell_id.as_deref() {
        content["commandShellId"] = json!(shell_id);
    }
    tools::ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: false,
        is_error: Some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code: Some(error_code.to_string()),
        command_shell_id,
    }
}

fn shell_changed_result(
    p: &ToolsExecuteParams,
    expected_shell_id: &str,
    expected_shell_dialect: Option<&str>,
    current_shell_id: Option<String>,
    current_shell_dialect: Option<&str>,
    started: std::time::Instant,
) -> tools::ToolsExecuteResult {
    let current = current_shell_id
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let mut result = shell_failure_result(
        p,
        "COMMAND_SHELL_CHANGED",
        format!(
            "command shell changed: expected '{expected_shell_id}', current effective shell is '{current}'"
        ),
        current_shell_id,
        started,
    );
    let mut content = json!({
        "error": result.content["error"],
        "code": "COMMAND_SHELL_CHANGED",
        "expectedCommandShellId": expected_shell_id,
        "commandShellId": current,
    });
    if let Some(expected_shell_dialect) = expected_shell_dialect {
        content["expectedCommandShellDialect"] = json!(expected_shell_dialect);
    }
    if let Some(current_shell_dialect) = current_shell_dialect {
        content["commandShellDialect"] = json!(current_shell_dialect);
    }
    result.content = content;
    result
}

fn plan_rpc_err(error: impl ToString) -> JsonRpcError {
    let message = error.to_string();
    let error_code = message
        .split_whitespace()
        .next()
        .filter(|code| code.starts_with("PLAN_"))
        .unwrap_or("PLAN_INTERNAL")
        .to_string();
    rpc_err(1015, message, &error_code)
}

fn resolve_persisted_project_workspace(
    state: &AppState,
    session_id: &str,
) -> Result<Option<String>, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(detail)) => Ok(detail.summary.project_path),
        // Compatibility fallback for old callers that did not persist a
        // session before dispatching a tool request.
        Ok(None) => Ok(state.workspace.path.clone()),
        Err(error) => Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
}

fn resolve_tool_workspace(
    state: &AppState,
    session_id: &str,
) -> Result<Option<String>, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(detail)) => {
            if let Some(project_path) = detail.summary.project_path {
                return Ok(Some(project_path));
            }
            let scratch = scratch::session_dir(&state.data_dir, session_id)
                .ok_or_else(|| rpc_err(1000, "temporary session has an invalid id", "INTERNAL"))?;
            std::fs::create_dir_all(&scratch)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            Ok(Some(scratch.to_string_lossy().into_owned()))
        }
        // Compatibility fallback for old callers that did not persist a
        // session before dispatching a tool request.
        Ok(None) => Ok(state.workspace.path.clone()),
        Err(error) => Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
}

/// Read/search tools are low risk inside their normal roots, but an explicit
/// path outside both roots is a separate capability. The check is deliberately
/// based on the same resolver used for execution so `..` and symlink escapes
/// cannot avoid the permission card. Scratch paths are recognized lexically
/// before the lazy scratch directory exists.
fn requires_external_path_permission(
    workspace_path: Option<&str>,
    scratch_path: Option<&Path>,
    tool_name: &str,
    args: &Value,
) -> bool {
    if !matches!(tool_name, "Read" | "Glob" | "Grep" | "Write" | "Edit") {
        return false;
    }
    let Some(path) = args.get("path").and_then(Value::as_str) else {
        return false;
    };
    if scratch_path.is_some_and(|root| workspace::lexically_inside(root, path)) {
        return false;
    }
    let Some(workspace_path) = workspace_path else {
        return false;
    };
    matches!(
        workspace::resolve_tool_path(Path::new(workspace_path), scratch_path, path),
        Err(error) if error == "PATH_OUTSIDE_WORKSPACE"
    )
}

/// Plans are owned by the session's persisted project. Unlike the legacy
/// tool compatibility resolver, a plan submission never inherits the mutable
/// global workspace or accepts a session-less request.
fn resolve_plan_workspace(state: &AppState, session_id: &str) -> Result<PathBuf, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(_)) => {}
        Ok(None) => return Err(plan_rpc_err("PLAN_SESSION_NOT_FOUND")),
        Err(error) => return Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
    resolve_persisted_project_workspace(state, session_id)?
        .map(PathBuf::from)
        .ok_or_else(|| plan_rpc_err("PLAN_WORKSPACE_REQUIRED"))
}

fn resolve_plan_workspace_if_available(
    state: &AppState,
    session_id: &str,
) -> Result<Option<PathBuf>, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(_)) => {}
        Ok(None) => return Err(plan_rpc_err("PLAN_SESSION_NOT_FOUND")),
        Err(error) => return Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
    Ok(resolve_persisted_project_workspace(state, session_id)?.map(PathBuf::from))
}

async fn emit_notification(tx: &mpsc::UnboundedSender<String>, method: &str, params: Value) {
    let note = JsonRpcNotification {
        jsonrpc: "2.0",
        method: method.to_string(),
        params,
    };
    if let Ok(raw) = serde_json::to_string(&note) {
        let _ = tx.send(format!("{raw}\n"));
    }
}

async fn wait_for_bash_cancellation(
    receiver: &mut Option<tokio::sync::watch::Receiver<bool>>,
) -> bool {
    let Some(receiver) = receiver.as_mut() else {
        return std::future::pending::<bool>().await;
    };
    if *receiver.borrow() {
        return true;
    }
    loop {
        if receiver.changed().await.is_err() {
            return std::future::pending::<bool>().await;
        }
        if *receiver.borrow() {
            return true;
        }
    }
}

fn bash_cancellation_requested(receiver: &Option<tokio::sync::watch::Receiver<bool>>) -> bool {
    receiver.as_ref().is_some_and(|receiver| *receiver.borrow())
}

async fn clear_bash_cancellation(state: &Arc<Mutex<AppState>>, p: &ToolsExecuteParams) {
    if p.tool_name != "Bash" {
        return;
    }
    let mut st = state.lock().await;
    st.clear_bash_cancellation(&p.session_id, &p.tool_call_id);
}

async fn cancel_pending_permission(state: &Arc<Mutex<AppState>>, p: &ToolsExecuteParams) -> bool {
    let mut st = state.lock().await;
    st.cancel_pending_permission(&p.session_id, &p.tool_call_id)
}

/// Dispatch a `plugin_*` tool to the desktop runner (Electron main), which
/// executes the plugin JS and answers via `plugins.resolveExecution`.
async fn execute_plugin_tool(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    p: &ToolsExecuteParams,
    timeout_ms: u64,
) -> tools::ToolsExecuteResult {
    let started = std::time::Instant::now();
    let execution_id = uuid::Uuid::new_v4().to_string();
    let (otx, orx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut st = state.lock().await;
        st.plugin_execs.insert(execution_id.clone(), otx);
    }
    emit_notification(
        tx,
        "plugins.execute",
        json!({
            "executionId": execution_id,
            "sessionId": p.session_id,
            "toolCallId": p.tool_call_id,
            "toolName": p.tool_name,
            "args": p.args,
        }),
    )
    .await;

    let outcome = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), orx).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(Ok(resp)) => {
            let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let content = resp.get("content").cloned().unwrap_or(Value::Null);
            let error_code = resp
                .get("errorCode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            tools::ToolsExecuteResult {
                tool_call_id: p.tool_call_id.clone(),
                ok,
                is_error: if ok { None } else { Some(true) },
                content,
                duration_ms,
                denied: None,
                error_code: if ok {
                    None
                } else {
                    Some(error_code.unwrap_or_else(|| "TOOL_FAILED".into()))
                },
                command_shell_id: None,
            }
        }
        _ => {
            let mut st = state.lock().await;
            st.plugin_execs.remove(&execution_id);
            tools::ToolsExecuteResult {
                tool_call_id: p.tool_call_id.clone(),
                ok: false,
                is_error: Some(true),
                content: json!({
                    "error": "plugin tool dispatch timed out or no desktop runner is attached",
                    "code": "TOOL_TIMEOUT"
                }),
                duration_ms,
                denied: None,
                error_code: Some("TOOL_TIMEOUT".into()),
                command_shell_id: None,
            }
        }
    }
}

fn plugin_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("PLUGIN_INVALID") {
        rpc_err(1009, msg, "PLUGIN_INVALID")
    } else if msg.contains("PLUGIN_LOAD_FAILED") {
        rpc_err(1010, msg, "PLUGIN_LOAD_FAILED")
    } else if msg.contains("PLUGIN_INTEGRITY") {
        rpc_err(1012, msg, "PLUGIN_INTEGRITY")
    } else if msg.contains("PLUGIN_PERMISSION_DENIED") {
        rpc_err(1013, msg, "PLUGIN_PERMISSION_DENIED")
    } else if msg.contains("PLUGIN_NOT_FOUND") {
        rpc_err(1003, msg, "NOT_FOUND")
    } else if msg.contains("PLUGIN_NETWORK") {
        rpc_err(1014, msg, "PLUGIN_NETWORK")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

/// Capability query failures have their own code so callers can distinguish
/// a missing project context from a malformed MCP or skill document.
fn capability_err(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1018, message, "CAPABILITY_INVALID")
}

/// Validation failures from the user-owned MCP registry are the user's typo,
/// not an internal fault, so they get a distinct code the UI can show inline.
fn scope_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("CAPABILITY_INVALID") {
        capability_err(msg)
    } else if msg.contains("MCP_INVALID") {
        rpc_err(1015, msg, "MCP_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

fn skill_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("CAPABILITY_INVALID") {
        capability_err(msg)
    } else if msg.contains("SKILL_INVALID") {
        rpc_err(1016, msg, "SKILL_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

/// Read the create/import/update payload for a user skill. Absent fields stay
/// absent so `update` can distinguish "unchanged" from "cleared".
fn parse_skill_input(params: &Value) -> Result<crate::user_skills::UserSkillInput, JsonRpcError> {
    let raw = params
        .get("skill")
        .cloned()
        .unwrap_or_else(|| params.clone());
    serde_json::from_value(raw).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

fn subagent_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("SUBAGENT_INVALID") {
        rpc_err(1017, msg, "SUBAGENT_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

/// Read the create/update payload for a user subagent. Absent fields stay absent
/// so `update` can distinguish "unchanged" from "cleared".
fn parse_subagent_input(
    params: &Value,
) -> Result<crate::user_subagents::UserSubagentInput, JsonRpcError> {
    let raw = params
        .get("subagent")
        .cloned()
        .unwrap_or_else(|| params.clone());
    serde_json::from_value(raw).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

fn require_id(params: &Value) -> Result<String, JsonRpcError> {
    params
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))
}

/// Read an `ActivationScope` from request params, accepting either a nested
/// `scope` object or the flat `mode`/`projects` pair the renderer sends.
fn parse_scope(params: &Value) -> Result<crate::activation::ActivationScope, JsonRpcError> {
    let raw = match params.get("scope") {
        Some(scope) => scope.clone(),
        None => json!({
            "mode": params.get("mode").cloned().unwrap_or(json!("global")),
            "projects": params.get("projects").cloned().unwrap_or(json!([])),
        }),
    };
    serde_json::from_value(raw).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

fn parse_capability_query(
    params: &Value,
) -> Result<(CapabilityLevel, Option<String>), JsonRpcError> {
    let level = CapabilityLevel::parse(params.get("level").and_then(Value::as_str))
        .map_err(|error| capability_err(error.to_string()))?;
    let project_path = params
        .get("projectPath")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    if level == CapabilityLevel::Project && project_path.is_none() {
        return Err(capability_err(
            "projectPath required for project capability queries",
        ));
    }
    Ok((level, project_path))
}

async fn handle_request(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    if method != "app.handshake" {
        let st = state.lock().await;
        if !st.handshook {
            return Err(rpc_err(1001, "handshake required", "UNAUTHORIZED"));
        }
        if st.shutting_down {
            return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
        }
    }

    match method {
        "app.handshake" => {
            let client_version = params
                .get("protocolVersion")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            if client_version != PROTOCOL_VERSION {
                return Err(rpc_err(
                    1011,
                    format!("protocol mismatch: client={client_version} host={PROTOCOL_VERSION}"),
                    "PROTOCOL_MISMATCH",
                ));
            }
            let mut st = state.lock().await;
            st.handshook = true;
            // Restore the current workspace from kv → projects.
            if let Ok(Some(pid)) = st.db.kv_get("app", "currentProjectId") {
                let pid = pid
                    .as_i64()
                    .or_else(|| pid.as_str().and_then(|s| s.parse::<i64>().ok()));
                if let Some(pid) = pid {
                    if let Ok(Some(path)) = st.db.project_path(pid) {
                        if !path.is_empty() {
                            st.workspace.set(PathBuf::from(path));
                        }
                    }
                }
            }
            Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "version": HOST_VERSION,
                "capabilities": [
                    "tools", "sessions", "providers", "secrets", "plugins", "permissions",
                    "scheduled", "artifacts", "plans", "search", "turns", "notifications", "a2a"
                ]
            }))
        }
        "app.health" => {
            let st = state.lock().await;
            let budget = st.tool_budget.snapshot();
            Ok(json!({
                "ok": true,
                "protocolVersion": PROTOCOL_VERSION,
                "version": HOST_VERSION,
                "uptimeMs": st.uptime_ms(),
                "toolBudget": {
                    "active": budget.active,
                    "queued": budget.queued,
                    "total": budget.total,
                    "shell": budget.shell,
                    "reads": budget.reads,
                    "mutations": budget.mutations,
                    "plugins": budget.plugins
                }
            }))
        }
        "keyboard.setGlobalShortcut" => {
            let binding = params
                .get("binding")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let enabled = crate::keyboard::uses_windows_fallback(binding);
            crate::keyboard::set_enabled(enabled);
            Ok(json!({ "enabled": enabled }))
        }
        "app.getVersion" => Ok(json!({
            "name": "pi-desktop-host-core",
            "version": HOST_VERSION,
            "protocolVersion": PROTOCOL_VERSION
        })),

        "workspace.get" => {
            let st = state.lock().await;
            Ok(json!({ "workspace": st.workspace.get() }))
        }
        "projects.list" => {
            let st = state.lock().await;
            let projects = st
                .db
                .list_projects()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "projects": projects }))
        }
        "workspace.set" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let ws = st.workspace.set(PathBuf::from(path));
            let pid = st
                .db
                .ensure_project(&ws.path, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            st.db
                .kv_set("app", "currentProjectId", &json!(pid))
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "workspace": ws }))
        }
        "workspace.clear" => {
            let mut st = state.lock().await;
            st.workspace.clear();
            st.db
                .kv_delete("app", "currentProjectId")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "review.rollback" => {
            let session_id = params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let snapshot_id = params
                .get("snapshotId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "snapshotId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let workspace_root = resolve_tool_workspace(&st, session_id)?;
            let outcome = review::rollback_change(
                &st.data_dir,
                session_id,
                snapshot_id,
                workspace_root.as_deref().map(std::path::Path::new),
            )
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            if matches!(outcome.status, "rolledBack" | "alreadyRolledBack") {
                sessions::update_tool_review_state(
                    &st.db,
                    session_id,
                    &outcome.message_id,
                    snapshot_id,
                    "rolledBack",
                )
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            }
            Ok(serde_json::to_value(outcome)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)
        }

        "settings.get" => {
            let st = state.lock().await;
            let stored = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(normalize_settings_value(stored.unwrap_or_else(|| {
                json!({
                    "defaultMode": "agent",
                    "defaultCommandShell": tools::shell::default_shell_id(),
                    "theme": "dark",
                    "enterToSend": true,
                    "largePasteThreshold": DEFAULT_LARGE_PASTE_THRESHOLD,
                    "contextCompaction": {
                        "enabled": true,
                        "reserveTokens": 16384,
                        "keepRecentTokens": 20000
                    },
                    "onboardingDismissed": false
                })
            })))
        }
        "settings.set" => {
            validate_settings_value(&params)?;
            let mut st = state.lock().await;
            let stored = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let incoming_shell = params.get("defaultCommandShell").and_then(Value::as_str);
            let current_effective_shell = effective_command_shell_id(stored.as_ref());
            if incoming_shell.is_some_and(|shell| current_effective_shell.as_deref() != Some(shell))
            {
                gate_default_command_shell_setting(&st)?;
            }
            let settings = normalize_settings_value(merge_settings_value(stored, params));
            st.db
                .set_setting("app", &settings)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // Re-pin the marketplace source in memory. Fetching here would hold
            // the state lock behind a remote timeout, so the renderer triggers
            // `market.refresh` after switching sources.
            let market_source = crate::plugins::market_source_from_settings(Some(&settings));
            st.plugins.set_market_source(market_source);
            Ok(json!({ "ok": true }))
        }

        "commandShells.list" => {
            let st = state.lock().await;
            let catalog = command_shell_catalog(&st)?;
            serde_json::to_value(catalog).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }

        "secrets.set" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "value required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let backend = st
                .secrets
                .set(secret_ref, value)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true, "backend": backend }))
        }
        "secrets.delete" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            st.secrets
                .delete(secret_ref)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "secrets.has" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            Ok(json!({ "has": st.secrets.has(secret_ref) }))
        }
        "secrets.getForRuntime" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let value = st
                .secrets
                .get(secret_ref)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "value": value }))
        }

        "providers.list" => {
            let include_disabled = params
                .get("includeDisabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let st = state.lock().await;
            let list = providers::list_providers(&st.db, &st.secrets, include_disabled)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "providers": list }))
        }
        "providers.create" => {
            let input: ProviderCreateInput = serde_json::from_value(params)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider = providers::create_provider(&st.db, &st.secrets, input)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "provider": provider }))
        }
        "providers.update" => {
            let input: ProviderUpdateInput = serde_json::from_value(params)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider = providers::update_provider(&st.db, &st.secrets, input)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "provider": provider }))
        }
        "providers.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = providers::delete_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "providers.get" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider = providers::get_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "provider": provider }))
        }
        "providers.getSecret" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let value = providers::get_secret_for_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "value": value }))
        }
        "providers.listModels" => {
            let provider_id = params.get("providerId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let models = providers::list_models(&st.db, provider_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "models": models }))
        }
        "providers.cacheModels" => {
            let input: CacheModelsParams = serde_json::from_value(params)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let cached =
                providers::cache_discovered_models(&st.db, &input.provider_id, &input.models)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let models = providers::list_models(&st.db, Some(&input.provider_id))
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "cached": cached, "models": models }))
        }
        "providers.testConnection" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider = providers::get_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "provider not found", "NOT_FOUND"))?;
            Ok(json!({
                "ok": provider.has_secret || provider.auth_kind == "none",
                "provider": provider
            }))
        }

        "session.list" => {
            let st = state.lock().await;
            let sessions = sessions::list_sessions(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "sessions": sessions }))
        }
        "session.create" => {
            let thinking_level = thinking_level_param(&params)?;
            let st = state.lock().await;
            let session = sessions::create_session_with_thinking(
                &st.db,
                params
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                params
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                params
                    .get("providerId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                params
                    .get("modelId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                params
                    .get("projectPath")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                thinking_level,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "session": session }))
        }
        "session.fork" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let title = params.get("title").and_then(|v| v.as_str());
            let through_message_id = params.get("throughMessageId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let session =
                match sessions::fork_session_through(&st.db, session_id, title, through_message_id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                {
                    sessions::ForkSessionResult::Created(session) => session,
                    sessions::ForkSessionResult::NotFound => {
                        return Err(rpc_err(1007, "session not found", "NOT_FOUND"))
                    }
                    sessions::ForkSessionResult::Busy => {
                        return Err(rpc_err(1008, "session is running", "CONFLICT"))
                    }
                };
            Ok(json!({ "session": session }))
        }
        "session.get" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let message_before = params.get("messageBefore").and_then(|v| v.as_i64());
            let message_limit = params.get("messageLimit").and_then(|v| v.as_i64());
            if message_before.is_some_and(|value| value < 0)
                || message_limit.is_some_and(|value| value <= 0)
            {
                return Err(rpc_err(
                    1002,
                    "session read window must use non-negative messageBefore and positive messageLimit",
                    "INVALID_PARAMS",
                ));
            }
            let content_limit = params
                .get("contentLimit")
                .and_then(|v| v.as_u64())
                .map(|limit| limit.min(256 * 1024) as usize);
            if params
                .get("contentLimit")
                .and_then(|value| value.as_u64())
                .is_some_and(|value| value == 0)
            {
                return Err(rpc_err(
                    1002,
                    "session contentLimit must be positive",
                    "INVALID_PARAMS",
                ));
            }
            let st = state.lock().await;
            let session = sessions::get_session_with_options(
                &st.db,
                id,
                sessions::SessionReadOptions {
                    message_before,
                    message_limit,
                    content_limit,
                },
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "session": session }))
        }
        "session.configure" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mode = params
                .get("mode")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "mode required", "INVALID_PARAMS"))?;
            let thinking_level = thinking_level_param(&params)?;
            let st = state.lock().await;
            let session = sessions::configure_session_with_thinking(
                &st.db,
                id,
                mode,
                params.get("providerId").and_then(|v| v.as_str()),
                params.get("modelId").and_then(|v| v.as_str()),
                thinking_level.as_deref(),
                params.get("permissionMode").and_then(|v| v.as_str()),
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
            Ok(json!({ "session": session }))
        }
        "session.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = sessions::delete_session(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if ok {
                scratch::remove_session_dir(&st.data_dir, id);
                review::remove_session(&st.data_dir, id);
            }
            Ok(json!({ "ok": ok }))
        }
        "session.rename" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "title required", "INVALID_PARAMS"))?;
            let title = sessions::normalize_session_title(title)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = sessions::rename_session(&st.db, id, &title)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "session.appendMessage" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let message: UiMessage = serde_json::from_value(
                params
                    .get("message")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "message required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let st = state.lock().await;
            sessions::append_message(&st.db, session_id, &message, turn_id.as_deref())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "session.appendCompaction" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let compaction: CompactionRecord = serde_json::from_value(
                params
                    .get("compaction")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "compaction required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            sessions::append_compaction(&st.db, session_id, &compaction)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "session.replaceMessages" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let messages: Vec<UiMessage> = serde_json::from_value(
                params
                    .get("messages")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "messages required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            sessions::replace_messages(&st.db, session_id, &messages)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "session.saveRevision" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let root_user_id = params
                .get("rootUserId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "rootUserId required", "INVALID_PARAMS"))?;
            let messages: Vec<UiMessage> = serde_json::from_value(
                params
                    .get("messages")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "messages required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let make_active = params
                .get("makeActive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let st = state.lock().await;
            let revision = sessions::save_message_revision(
                &st.db,
                session_id,
                root_user_id,
                &messages,
                make_active,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "revision": revision }))
        }
        "session.saveActiveRevision" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let saved = sessions::save_active_branch_revision(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "saved": saved }))
        }
        "session.listRevisions" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let root_user_id = params
                .get("rootUserId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "rootUserId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let revisions = sessions::list_message_revisions(&st.db, session_id, root_user_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "revisions": revisions }))
        }
        "session.activateRevision" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let root_user_id = params
                .get("rootUserId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "rootUserId required", "INVALID_PARAMS"))?;
            let revision_index = params
                .get("revisionIndex")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| rpc_err(1002, "revisionIndex required", "INVALID_PARAMS"))?;
            let prefix: Vec<UiMessage> =
                serde_json::from_value(params.get("prefix").cloned().unwrap_or_else(|| json!([])))
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let messages = sessions::activate_message_revision(
                &st.db,
                session_id,
                root_user_id,
                revision_index,
                &prefix,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "messages": messages }))
        }
        "session.getScratchPath" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let path = scratch::session_dir(&st.data_dir, session_id)
                .ok_or_else(|| rpc_err(1002, "invalid session id", "INVALID_PARAMS"))?;
            Ok(json!({ "path": path.to_string_lossy() }))
        }

        "session.import" => {
            let summary: sessions::SessionSummary = serde_json::from_value(
                params
                    .get("session")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "session required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let messages: Vec<UiMessage> = serde_json::from_value(
                params
                    .get("messages")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "messages required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let imported = sessions::import_session(&st.db, &summary, &messages)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true, "imported": imported, "skipped": !imported }))
        }

        "session.beginTurn" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let turn_id = sessions::begin_turn(
                &st.db,
                session_id,
                params.get("providerId").and_then(|v| v.as_str()),
                params.get("modelId").and_then(|v| v.as_str()),
            )
            .map_err(|e| {
                let message = e.to_string();
                if message == "AGENT_BUSY" {
                    rpc_err(1008, message, "AGENT_BUSY")
                } else {
                    rpc_err(1000, message, "INTERNAL")
                }
            })?;
            Ok(json!({ "turnId": turn_id }))
        }
        "session.endTurn" => {
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let status = params
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            let st = state.lock().await;
            let result = sessions::end_turn(
                &st.db,
                turn_id,
                status,
                params.get("errorCode").and_then(|v| v.as_str()),
                params.get("usage"),
                params
                    .get("createNotification")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let mut response = json!({ "ok": result.updated });
            if let Some(notification) = result.notification {
                response["notification"] = json!(notification);
            }
            Ok(response)
        }

        "notification.list" => {
            let unread_only = params
                .get("unreadOnly")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let limit = params
                .get("limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(crate::db::NOTIFICATION_KEEP);
            let st = state.lock().await;
            let (notifications, unread_count) = notifications::list(&st.db, unread_only, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "notifications": notifications,
                "unreadCount": unread_count
            }))
        }
        "notification.markRead" => {
            let id = params
                .get("id")
                .and_then(|value| value.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = notifications::mark_read(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "notification.markAllRead" => {
            let st = state.lock().await;
            notifications::mark_all_read(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "notification.clear" => {
            let st = state.lock().await;
            notifications::clear(&st.db).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }

        "search.query" => {
            let query = params
                .get("query")
                .or_else(|| params.get("q"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(20);
            let st = state.lock().await;
            let hits = sessions::search_messages(&st.db, query, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "hits": hits }))
        }

        "artifacts.list" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(200);
            let st = state.lock().await;
            let artifacts = artifacts::list(&st.db, session_id, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "artifacts": artifacts }))
        }

        "plans.pending" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let (pending, planning_state, kind) = {
                let crate::state::AppState { db, plans, .. } = &*st;
                let pending = plans
                    .pending_for_session(db, session_id)
                    .map_err(plan_rpc_err)?;
                let planning_state = session_id
                    .map(|id| plans.state_for_session(db, id))
                    .transpose()
                    .map_err(plan_rpc_err)?;
                // The session's own mode names the contract being authored even
                // when no proposal exists yet (Plan/Goal `planning`).
                let kind = session_id
                    .map(|id| plans.active_kind(db, id))
                    .transpose()
                    .map_err(plan_rpc_err)?
                    .flatten();
                (pending, planning_state, kind)
            };
            Ok(json!({ "plans": pending, "state": planning_state, "kind": kind }))
        }
        "plans.enter" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|id| id.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|id| id.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            // Older sidecars only knew Plan; absent means Plan (D198).
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or(plans::KIND_PLAN);
            let kind = plans::normalize_kind(kind)
                .ok_or_else(|| rpc_err(1002, "kind must be 'plan' or 'goal'", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let planning_state = {
                let crate::state::AppState { db, plans, .. } = &*st;
                plans
                    .enter(db, session_id, turn_id, tool_call_id, kind)
                    .map_err(plan_rpc_err)?;
                plans
                    .state_for_session(db, session_id)
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": session_id,
                    "state": planning_state,
                    "kind": kind,
                }),
            )
            .await;
            Ok(json!({ "ok": true, "state": planning_state, "kind": kind }))
        }
        "plans.submit" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "title required", "INVALID_PARAMS"))?;
            let markdown = params
                .get("markdown")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "markdown required", "INVALID_PARAMS"))?;
            let question = params
                .get("question")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "question required", "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or(plans::KIND_PLAN);
            let kind = plans::normalize_kind(kind)
                .ok_or_else(|| rpc_err(1002, "kind must be 'plan' or 'goal'", "INVALID_PARAMS"))?;
            let proposal = {
                let guard = state.lock().await;
                let st = &*guard;
                let workspace = resolve_plan_workspace(st, session_id)?;
                st.plans
                    .submit(
                        &st.db,
                        crate::plans::PlanSubmitParams {
                            workspace_root: &workspace,
                            session_id,
                            turn_id,
                            tool_call_id,
                            kind,
                            title,
                            markdown,
                            question,
                        },
                    )
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": session_id,
                    "state": "awaiting_approval",
                    "kind": proposal.kind,
                    "proposalId": proposal.id,
                    "proposal": proposal
                }),
            )
            .await;
            Ok(json!({ "status": "pending", "proposal": proposal }))
        }
        "plans.resolve" => {
            let proposal_id = params
                .get("proposalId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "proposalId required", "INVALID_PARAMS"))?;
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let version = params.get("version").and_then(|v| v.as_i64());
            let target = params.get("targetPermissionMode").and_then(|v| v.as_str());
            let resolution = {
                let guard = state.lock().await;
                let st = &*guard;
                let workspace = if action == "approve" {
                    resolve_plan_workspace_if_available(st, session_id)?
                } else {
                    None
                };
                st.plans
                    .resolve(
                        &st.db,
                        crate::plans::PlanResolveParams {
                            workspace_root: workspace.as_deref(),
                            proposal_id,
                            session_id,
                            turn_id,
                            tool_call_id,
                            version,
                            action,
                            target_permission_mode: target,
                        },
                    )
                    .map_err(plan_rpc_err)?
            };
            let state_name = if resolution.status == plans::STATUS_APPROVED {
                "inactive"
            } else {
                "planning"
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": resolution.proposal.session_id,
                    "state": state_name,
                    "kind": resolution.proposal.kind,
                    "proposalId": resolution.proposal.id,
                    "proposal": resolution.proposal,
                    "action": resolution.action,
                    "targetPermissionMode": resolution.target_permission_mode,
                    "execution": resolution.execution
                }),
            )
            .await;
            Ok(json!({
                "ok": true,
                "proposal": resolution.proposal,
                "state": state_name,
                "action": resolution.action,
                "targetPermissionMode": resolution.target_permission_mode,
                "execution": resolution.execution
            }))
        }
        "plans.queuedExecutions" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let executions = st
                .plans
                .queued_executions(&st.db, session_id)
                .map_err(plan_rpc_err)?;
            Ok(json!({ "executions": executions }))
        }
        "plans.claimExecution" => {
            let execution_id = params
                .get("executionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "executionId required", "INVALID_PARAMS"))?;
            let execution = {
                let st = state.lock().await;
                st.plans
                    .claim_execution(&st.db, execution_id)
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": execution.session_id,
                    "proposalId": execution.proposal_id,
                    "state": "inactive",
                    "kind": execution.kind,
                    "execution": execution,
                }),
            )
            .await;
            Ok(json!({ "execution": execution }))
        }
        "plans.finishExecution" => {
            let execution_id = params
                .get("executionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "executionId required", "INVALID_PARAMS"))?;
            let status = params
                .get("status")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "status required", "INVALID_PARAMS"))?;
            let execution = {
                let st = state.lock().await;
                st.plans
                    .finish_execution(
                        &st.db,
                        execution_id,
                        status,
                        params.get("errorCode").and_then(|v| v.as_str()),
                    )
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": execution.session_id,
                    "proposalId": execution.proposal_id,
                    "state": "inactive",
                    "kind": execution.kind,
                    "execution": execution,
                }),
            )
            .await;
            Ok(json!({ "execution": execution }))
        }
        "plans.abort" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let (changed, kind) = {
                let st = state.lock().await;
                let changed = st
                    .plans
                    .abort_session(&st.db, session_id)
                    .map_err(plan_rpc_err)?;
                // Only a session that still exists can name the contract it
                // returns to, and only such a session can have changed here.
                let kind = if changed {
                    st.plans
                        .active_kind(&st.db, session_id)
                        .map_err(plan_rpc_err)?
                } else {
                    None
                };
                (changed, kind)
            };
            if changed {
                emit_notification(
                    &tx,
                    "plans.changed",
                    json!({ "sessionId": session_id, "state": "planning", "kind": kind }),
                )
                .await;
            }
            Ok(json!({ "ok": true, "changed": changed }))
        }

        "scheduled.list" => {
            let st = state.lock().await;
            let tasks = scheduled::list_tasks(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "tasks": tasks }))
        }
        "scheduled.create" => {
            let st = state.lock().await;
            let task = scheduled::create_task(&st.db, &params)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "task": task }))
        }
        "scheduled.update" => {
            let st = state.lock().await;
            let task = scheduled::update_task(&st.db, &params)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
            Ok(json!({ "task": task }))
        }
        "scheduled.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = scheduled::delete_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "scheduled.import" => {
            let tasks = params
                .get("tasks")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let st = state.lock().await;
            let imported = scheduled::import_tasks(&st.db, &tasks)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "imported": imported }))
        }
        "scheduled.run" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let task = scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
            // Both contract modes need a human to approve their proposal (D198),
            // so neither can run unattended.
            if sessions::is_contract_mode(&task.mode) {
                return Err(plan_rpc_err("PLAN_REQUIRES_INTERACTIVE_SESSION"));
            }
            let settings = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or_else(|| json!({}));
            let session = sessions::create_session(
                &st.db,
                Some(task.title.clone()),
                Some("agent".into()),
                settings
                    .get("defaultProviderId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                settings
                    .get("defaultModelId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                st.workspace.get().map(|w| w.path),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let run_id = match scheduled::begin_run(&st.db, id, Some(&session.id)) {
                Ok(run_id) => run_id,
                Err(error) => {
                    let _ = sessions::delete_session(&st.db, &session.id);
                    return Err(rpc_err(1000, error.to_string(), "INTERNAL"));
                }
            };
            let task = scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or(task);
            Ok(json!({
                "sessionId": session.id,
                "prompt": task.prompt,
                "task": task,
                "runId": run_id
            }))
        }
        "scheduled.finishRun" => {
            let run_id = params
                .get("runId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "runId required", "INVALID_PARAMS"))?;
            let status = params
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            let st = state.lock().await;
            let ok = scheduled::finish_run(
                &st.db,
                run_id,
                status,
                params.get("errorCode").and_then(|v| v.as_str()),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "scheduled.listRuns" => {
            let task_id = params.get("taskId").and_then(|v| v.as_str());
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(50);
            let st = state.lock().await;
            let runs = scheduled::list_runs(&st.db, task_id, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "runs": runs }))
        }

        "tools.list" => Ok(json!({ "tools": tools::builtin_tool_defs() })),
        "tools.execute" => {
            // Segmented timing (D137): a slow tool call is almost never slow
            // *inside* the tool — the wait is either the approval prompt or the
            // model round trip that follows. Splitting the host's own share
            // into approval / execution / bookkeeping is what makes the three
            // distinguishable in host/timing.log instead of one opaque
            // duration.
            let call_started = std::time::Instant::now();
            let p: ToolsExecuteParams = serde_json::from_value(params.clone())
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let execution_timeout_ms = tools::effective_timeout_ms(&p.tool_name, p.timeout_ms);

            let command_shell_id = if p.tool_name == "Bash" {
                let catalog = {
                    let st = state.lock().await;
                    command_shell_catalog(&st)?
                };
                let effective_id = catalog.effective.as_ref().map(|shell| shell.id.clone());
                let shell_id = effective_id
                    .clone()
                    .or_else(|| Some(catalog.configured_id.clone()));
                let Some(effective) = catalog.effective.as_ref() else {
                    let result = shell_failure_result(
                        &p,
                        "SHELL_NOT_FOUND",
                        tools::shell::SHELL_MISSING_GUIDANCE,
                        shell_id,
                        call_started,
                    );
                    return serde_json::to_value(result)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                };
                let Some(expected) = p.expected_command_shell_id.as_deref() else {
                    let result = shell_failure_result(
                        &p,
                        "COMMAND_SHELL_CHANGED",
                        "expectedCommandShellId is required for Bash execution",
                        Some(effective.id.clone()),
                        call_started,
                    );
                    return serde_json::to_value(result)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                };
                let expected_dialect = p.expected_command_shell_dialect.as_deref();
                if expected_dialect != Some(effective.dialect.as_str()) || expected != effective.id
                {
                    let result = shell_changed_result(
                        &p,
                        expected,
                        expected_dialect,
                        Some(effective.id.clone()),
                        Some(effective.dialect.as_str()),
                        call_started,
                    );
                    return serde_json::to_value(result)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                }
                effective_id
            } else {
                None
            };

            let durable_mode = {
                let st = state.lock().await;
                if st.shutting_down {
                    return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
                }
                sessions::session_mode(&st.db, &p.session_id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                    .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?
            };

            // Register before permission evaluation so tools.abort can cancel
            // an approval wait as well as an already-spawned process.
            let cancellation_receiver = if p.tool_name == "Bash" {
                let mut st = state.lock().await;
                match st.register_bash_cancellation(&p.session_id, &p.tool_call_id) {
                    Ok(receiver) => Some(receiver),
                    Err(error_code) => {
                        let result = shell_failure_result(
                            &p,
                            &error_code,
                            "another Bash call is already active for this tool call ID",
                            command_shell_id.clone(),
                            call_started,
                        );
                        return serde_json::to_value(result)
                            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                    }
                }
            } else {
                None
            };

            let outcome: Result<Value, JsonRpcError> = async {
                let (
                    auto_decision,
                    workspace_path,
                    scratch_path,
                    external_path_permission,
                    pending_rx,
                    request_opt,
                    permission_shell_id,
                ) = {
                    let mut st = state.lock().await;
                    if st.shutting_down {
                        return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
                    }
                    st.permissions.expire_stale();
                    // Effective permission mode (D115): per-session override
                    // unless it is `inherit`, then the global settings default,
                    // then `ask`. A subagent's tool call carries its own scope
                    // (ADR 0089), which resolves the call under that mode
                    // instead; external-path gating and the contract modes'
                    // hard deny are untouched by the override.
                    let session_pm = sessions::session_permission_mode(&st.db, &p.session_id)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                        .filter(|m| m != "inherit");
                    let effective_pm = match session_pm {
                        Some(m) => m,
                        None => st
                            .db
                            .get_setting("app")
                            .ok()
                            .flatten()
                            .and_then(|s| {
                                s.get("defaultPermissionMode")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                            })
                            .filter(|m| sessions::is_valid_permission_mode(m) && m != "inherit")
                            .unwrap_or_else(|| "ask".to_string()),
                    };
                    let effective_pm = match p.permission_scope.as_deref() {
                        Some(scope)
                            if sessions::is_valid_permission_mode(scope) && scope != "inherit" =>
                        {
                            scope.to_string()
                        }
                        _ => effective_pm,
                    };
                    // Resolve the tool root from the persisted session instead of
                    // the mutable global workspace. This keeps background turns
                    // isolated when the renderer switches between project tabs.
                    // The session's project remains the containment root for all
                    // known sessions.
                    let ws = resolve_tool_workspace(&st, &p.session_id)?;
                    let scratch = scratch::session_dir(&st.data_dir, &p.session_id);
                    let external_path_permission = requires_external_path_permission(
                        ws.as_deref(),
                        scratch.as_deref(),
                        &p.tool_name,
                        &p.args,
                    );
                    let mut auto = st
                        .permissions
                        .evaluate_auto_with_permission_mode_and_risk_and_path(
                            &p.session_id,
                            &p.tool_name,
                            &durable_mode,
                            &effective_pm,
                            &st.session_grants,
                            p.declared_risk.as_deref(),
                            external_path_permission,
                        );
                    // Write/Edit targeting the session scratch dir never touch
                    // the user's project — skip the prompt (D114). The lexical
                    // pre-check only decides prompting; execution still goes
                    // through the symlink-aware resolver, so it cannot be used
                    // to escape containment. A contract mode's hard deny is
                    // never bypassed.
                    if !sessions::is_contract_mode(&durable_mode)
                        && auto.is_none()
                        && matches!(p.tool_name.as_str(), "Write" | "Edit")
                    {
                        if let (Some(scratch_dir), Some(path)) = (
                            scratch.as_deref(),
                            p.args.get("path").and_then(|v| v.as_str()),
                        ) {
                            if workspace::lexically_inside(scratch_dir, path) {
                                auto = Some(PermissionDecision::AllowOnce);
                            }
                        }
                    }
                    if let Some(decision) = auto {
                        (
                            Some(decision),
                            ws,
                            scratch,
                            external_path_permission,
                            None,
                            None,
                            command_shell_id.clone(),
                        )
                    } else {
                        let reason = if external_path_permission {
                            "Accesses a path outside the session workspace"
                        } else {
                            match p.tool_name.as_str() {
                                "Write" | "Edit" => "Modifies files in your workspace",
                                "Bash" => "Runs a shell command in your workspace",
                                name if name.starts_with("mcp_") => {
                                    "MCP server tool requires approval"
                                }
                                name if name.starts_with("plugin_") => {
                                    "Plugin-provided tool requires approval"
                                }
                                _ => "High-risk tool requires approval",
                            }
                        };
                        let (req, rx) = st.permissions.create_request_with_risk_and_shell(
                            crate::permissions::PermissionRequestParams {
                                session_id: &p.session_id,
                                tool_call_id: &p.tool_call_id,
                                tool_name: &p.tool_name,
                                args_preview: p.args.clone(),
                                reason,
                                declared_risk: p.declared_risk.as_deref(),
                                command_shell_id: command_shell_id.as_deref(),
                            },
                        );
                        st.register_pending_permission(
                            &req.request_id,
                            &req.session_id,
                            &req.tool_call_id,
                        );
                        (
                            None,
                            ws,
                            scratch,
                            external_path_permission,
                            Some(rx),
                            Some(req),
                            command_shell_id.clone(),
                        )
                    }
                };

                let prompted = request_opt.is_some();
                let mut permission_cancellation = cancellation_receiver.clone();
                let mut cancelled = bash_cancellation_requested(&permission_cancellation);
                if cancelled {
                    let _ = cancel_pending_permission(&state, &p).await;
                }
                if !cancelled {
                    if let Some(req) = request_opt {
                        let mut permission_params = json!({
                            "requestId": req.request_id,
                            "sessionId": req.session_id,
                            "toolCallId": req.tool_call_id,
                            "toolName": req.tool_name,
                            "risk": req.risk,
                            "argsPreview": req.args_preview,
                            "reason": req.reason,
                            "timeoutMs": req.timeout_ms
                        });
                        if let Some(shell_id) = req.command_shell_id.as_deref() {
                            permission_params["commandShellId"] = json!(shell_id);
                        }
                        emit_notification(&tx, "permissions.request", permission_params).await;
                        tracing::info!(
                            request_id = %req.request_id,
                            tool = %req.tool_name,
                            command_shell_id = permission_shell_id.as_deref(),
                            "permission required"
                        );
                    }
                }

                let final_decision = if cancelled {
                    PermissionDecision::Deny
                } else if let Some(d) = auto_decision {
                    cancelled = bash_cancellation_requested(&permission_cancellation);
                    if cancelled {
                        let _ = cancel_pending_permission(&state, &p).await;
                        PermissionDecision::Deny
                    } else {
                        d
                    }
                } else if let Some(rx) = pending_rx {
                    let permission_wait = tokio::time::timeout(
                        std::time::Duration::from_millis(crate::permissions::PERMISSION_TIMEOUT_MS),
                        rx,
                    );
                    tokio::pin!(permission_wait);
                    tokio::select! {
                        outcome = &mut permission_wait => match outcome {
                            Ok(Ok(d)) => d,
                            _ => PermissionDecision::Deny,
                        },
                        _ = wait_for_bash_cancellation(&mut permission_cancellation) => {
                            let _ = cancel_pending_permission(&state, &p).await;
                            cancelled = true;
                            PermissionDecision::Deny
                        },
                    }
                } else {
                    PermissionDecision::Deny
                };
                cancelled = cancelled || bash_cancellation_requested(&permission_cancellation);
                if cancelled {
                    let _ = cancel_pending_permission(&state, &p).await;
                }
                // Everything up to here is approval: the auto-decision path costs
                // microseconds, the prompt path costs however long the user took.
                let permission_wait_ms = call_started.elapsed().as_millis() as u64;

                if matches!(final_decision, PermissionDecision::Deny) {
                    let _ = cancel_pending_permission(&state, &p).await;
                    let st = state.lock().await;
                    let mut denied_audit = json!({
                        "toolName": p.tool_name,
                        "toolCallId": p.tool_call_id,
                        "mode": durable_mode,
                        "externalPathPermission": external_path_permission,
                        "prompted": prompted,
                        "permissionWaitMs": permission_wait_ms,
                        "totalMs": call_started.elapsed().as_millis() as u64
                    });
                    if let Some(shell_id) = permission_shell_id.as_deref() {
                        denied_audit["commandShellId"] = json!(shell_id);
                    }
                    let _ = audit::append(
                        &st.db,
                        if cancelled {
                            "tool_aborted"
                        } else {
                            "tool_denied"
                        },
                        Some(&p.session_id),
                        denied_audit,
                    );
                    tracing::info!(
                        tool = %p.tool_name,
                        tool_call_id = %p.tool_call_id,
                        session_id = %p.session_id,
                        prompted,
                        permission_wait_ms,
                        execute_ms = 0,
                        overhead_ms = 0,
                        total_ms = call_started.elapsed().as_millis() as u64,
                        command_shell_id = permission_shell_id.as_deref(),
                        outcome = if cancelled { "aborted" } else { "denied" },
                        "tool timing"
                    );
                    let error_code = if cancelled {
                        "TOOL_ABORTED"
                    } else if sessions::is_contract_mode(&durable_mode)
                        && !PermissionManager::plan_mode_allows(&p.tool_name)
                    {
                        match p.tool_name.as_str() {
                            "Write" => "WRITE_DISABLED_IN_PLAN",
                            "Edit" => "EDIT_DISABLED_IN_PLAN",
                            name if name.starts_with("plugin_") => "PLUGIN_DISABLED_IN_PLAN",
                            _ => "TOOL_DISABLED_IN_PLAN",
                        }
                    } else {
                        "TOOL_DENIED"
                    };
                    let mut denied_result = json!({
                        "toolCallId": p.tool_call_id,
                        "ok": false,
                        "isError": true,
                        "content": {
                            "error": if cancelled { "tool aborted" } else { "permission denied" },
                            "code": error_code
                        },
                        "durationMs": 0,
                        "denied": !cancelled,
                        "errorCode": error_code
                    });
                    if let Some(shell_id) = permission_shell_id.as_deref() {
                        denied_result["commandShellId"] = json!(shell_id);
                    }
                    return Ok(denied_result);
                }

                if matches!(final_decision, PermissionDecision::AllowSession) {
                    let mut st = state.lock().await;
                    st.session_grants
                        .entry(p.session_id.clone())
                        .or_default()
                        .push(p.tool_name.clone());
                }

                // Admission follows permission so approval waits do not occupy
                // execution capacity. Keep this permit through review, the
                // runner, and bookkeeping so every accepted call is bounded.
                let tool_budget = {
                    let st = state.lock().await;
                    st.tool_budget.clone()
                };
                let _tool_permit = match tool_budget.acquire(&p.session_id, &p.tool_name).await {
                    Ok(permit) => permit,
                    Err(error) => {
                        tracing::warn!(
                            tool = %p.tool_name,
                            session_id = %p.session_id,
                            error_code = error.code(),
                            "tool admission rejected"
                        );
                        let mut result = json!({
                            "toolCallId": p.tool_call_id,
                            "ok": false,
                            "isError": true,
                            "content": {
                                "error": error.message(),
                                "code": error.code()
                            },
                            "durationMs": call_started.elapsed().as_millis() as u64,
                            "denied": false,
                            "errorCode": error.code()
                        });
                        if let Some(shell_id) = permission_shell_id.as_deref() {
                            result["commandShellId"] = json!(shell_id);
                        }
                        return Ok(result);
                    }
                };

                let ws_path = workspace_path.map(PathBuf::from);
                let data_dir = { state.lock().await.data_dir.clone() };
                let pending_review = review::prepare_change(
                    &data_dir,
                    &p.session_id,
                    &p.tool_call_id,
                    ws_path.as_deref(),
                    scratch_path.as_deref(),
                    &p.tool_name,
                    &p.args,
                )
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        session_id = %p.session_id,
                        tool_call_id = %p.tool_call_id,
                        error = %error,
                        "review snapshot preparation failed"
                    );
                    None
                });
                let mut bash_options = None;
                if p.tool_name == "Bash" {
                    let (shell_id, cancellation) = {
                        let st = state.lock().await;
                        let catalog = command_shell_catalog(&st)?;
                        let Some(effective) = catalog.effective.as_ref() else {
                            let result = shell_failure_result(
                                &p,
                                "SHELL_NOT_FOUND",
                                tools::shell::SHELL_MISSING_GUIDANCE,
                                Some(catalog.configured_id.clone()),
                                call_started,
                            );
                            return serde_json::to_value(result)
                                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                        };
                        let Some(expected) = p.expected_command_shell_id.as_deref() else {
                            let result = shell_failure_result(
                                &p,
                                "COMMAND_SHELL_CHANGED",
                                "expectedCommandShellId is required for Bash execution",
                                Some(effective.id.clone()),
                                call_started,
                            );
                            return serde_json::to_value(result)
                                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                        };
                        let expected_dialect = p.expected_command_shell_dialect.as_deref();
                        if expected_dialect != Some(effective.dialect.as_str())
                            || expected != effective.id
                        {
                            let result = shell_changed_result(
                                &p,
                                expected,
                                expected_dialect,
                                Some(effective.id.clone()),
                                Some(effective.dialect.as_str()),
                                call_started,
                            );
                            return serde_json::to_value(result)
                                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                        }
                        (effective.id.clone(), cancellation_receiver.clone())
                    };
                    bash_options = Some(tools::BashExecutionOptions {
                        session_id: p.session_id.clone(),
                        tool_call_id: p.tool_call_id.clone(),
                        command_shell_id: shell_id,
                        timeout_ms: execution_timeout_ms,
                        cancellation,
                        output_tx: Some(tx.clone()),
                    });
                }

                let mut result = if tools::is_desktop_dispatched(&p.tool_name) {
                    // Plugin dispatch keeps its existing bounded default timeout;
                    // command-shell timeout semantics apply only to Bash.
                    execute_plugin_tool(&state, &tx, &p, p.timeout_ms.unwrap_or(60_000)).await
                } else {
                    tools::execute_tool_with_path_access(
                        ws_path.as_deref(),
                        scratch_path.as_deref(),
                        &p.tool_name,
                        &p.args,
                        execution_timeout_ms,
                        bash_options,
                        external_path_permission,
                    )
                    .await
                };
                result.tool_call_id = p.tool_call_id.clone();

                if let Some(pending) = pending_review {
                    if result.ok {
                        match review::finalize_change(&pending) {
                            Ok(change) => {
                                if let Some(object) = result.content.as_object_mut() {
                                    object.insert(
                                        "review".to_string(),
                                        serde_json::to_value(change).map_err(|error| {
                                            rpc_err(1000, error.to_string(), "INTERNAL")
                                        })?,
                                    );
                                }
                            }
                            Err(error) => {
                                tracing::warn!(
                                    session_id = %p.session_id,
                                    tool_call_id = %p.tool_call_id,
                                    error = %error,
                                    "review snapshot finalization failed"
                                );
                                review::discard_change(pending);
                            }
                        }
                    } else {
                        review::discard_change(pending);
                    }
                }

                let st = state.lock().await;
                // Scratch files are temp by definition: keep them out of the
                // artifacts table so the work panel file list only shows
                // workspace deliverables (D114).
                let result_root = result.content.get("root").and_then(|v| v.as_str());
                if result.ok
                    && result_root == Some("workspace")
                    && matches!(p.tool_name.as_str(), "Write" | "Edit")
                {
                    if let Some(rel) = result.content.get("path").and_then(|v| v.as_str()) {
                        let abs = match ws_path.as_deref() {
                            Some(root) => root.join(rel).to_string_lossy().to_string(),
                            None => rel.to_string(),
                        };
                        let op = if p.tool_name == "Write" {
                            "write"
                        } else {
                            "edit"
                        };
                        let _ = artifacts::record(
                            &st.db,
                            &p.session_id,
                            &abs,
                            op,
                            p.turn_id.as_deref(),
                        );
                    }
                }
                // `overhead_ms` is the host's own share outside approval and the
                // tool body: workspace resolution, the state lock, artifacts and
                // audit writes. It should stay near zero; if it does not, the
                // bottleneck is host-core itself rather than the user or the model.
                let total_ms = call_started.elapsed().as_millis() as u64;
                let overhead_ms =
                    total_ms.saturating_sub(permission_wait_ms.saturating_add(result.duration_ms));
                let mut execute_audit = json!({
                    "toolName": p.tool_name,
                    "toolCallId": p.tool_call_id,
                    "externalPathPermission": external_path_permission,
                    "ok": result.ok,
                    "durationMs": result.duration_ms,
                    "errorCode": result.error_code,
                    "prompted": prompted,
                    "permissionWaitMs": permission_wait_ms,
                    "overheadMs": overhead_ms,
                    "totalMs": total_ms
                });
                if let Some(shell_id) = result.command_shell_id.as_deref() {
                    execute_audit["commandShellId"] = json!(shell_id);
                }
                let _ = audit::append(&st.db, "tool_execute", Some(&p.session_id), execute_audit);
                tracing::info!(
                    tool = %p.tool_name,
                    tool_call_id = %p.tool_call_id,
                    session_id = %p.session_id,
                    prompted,
                    permission_wait_ms,
                    execute_ms = result.duration_ms,
                    overhead_ms,
                    total_ms,
                    command_shell_id = result.command_shell_id.as_deref(),
                    outcome = if result.ok { "ok" } else { "error" },
                    "tool timing"
                );

                serde_json::to_value(result).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
            }
            .await;
            clear_bash_cancellation(&state, &p).await;
            outcome
        }

        "tools.abort" => {
            let session_id = params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let permission_found = st.cancel_pending_permission(session_id, tool_call_id);
            let (process_found, queued) = st.abort_or_queue_bash(session_id, tool_call_id);
            let found = process_found || permission_found;
            Ok(json!({
                "ok": true,
                "found": found,
                "queued": queued,
                "aborted": found || queued
            }))
        }

        "permissions.evaluate" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tool_name = params
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let declared_risk = params.get("declaredRisk").and_then(|v| v.as_str());
            let st = state.lock().await;
            let Some(mode) = sessions::session_mode(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            else {
                return Err(rpc_err(1007, "session not found", "SESSION_NOT_FOUND"));
            };
            let session_pm = sessions::session_permission_mode(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .filter(|value| value != "inherit");
            let effective_pm = session_pm
                .or_else(|| {
                    st.db
                        .get_setting("app")
                        .ok()
                        .flatten()
                        .and_then(|settings| {
                            settings
                                .get("defaultPermissionMode")
                                .and_then(|value| value.as_str())
                                .filter(|value| {
                                    sessions::is_valid_permission_mode(value) && *value != "inherit"
                                })
                                .map(str::to_string)
                        })
                })
                .unwrap_or_else(|| "ask".into());
            let workspace_path = resolve_tool_workspace(&st, session_id)?;
            let scratch_path = scratch::session_dir(&st.data_dir, session_id);
            let args = params.get("args").cloned().unwrap_or_else(|| json!({}));
            let external_path_permission = requires_external_path_permission(
                workspace_path.as_deref(),
                scratch_path.as_deref(),
                tool_name,
                &args,
            );
            let decision = st
                .permissions
                .evaluate_auto_with_permission_mode_and_risk_and_path(
                    session_id,
                    tool_name,
                    &mode,
                    &effective_pm,
                    &st.session_grants,
                    declared_risk,
                    external_path_permission,
                );
            Ok(json!({
                "decision": decision,
                "risk": PermissionManager::tool_risk_with_declared(tool_name, declared_risk),
                "externalPathPermission": external_path_permission
            }))
        }
        "permissions.resolve" => {
            let request_id = params
                .get("requestId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "requestId required", "INVALID_PARAMS"))?;
            let decision_raw = params
                .get("decision")
                .and_then(|v| v.as_str())
                .unwrap_or("deny");
            let decision = match decision_raw {
                "allow-once" => PermissionDecision::AllowOnce,
                "allow-session" => PermissionDecision::AllowSession,
                _ => PermissionDecision::Deny,
            };
            let mut st = state.lock().await;
            st.resolve_permission(request_id, decision)
                .map_err(|code| {
                    let c = if code == "NOT_FOUND" { 1007 } else { 1000 };
                    rpc_err(c, code.clone(), &code)
                })?;
            Ok(json!({ "ok": true }))
        }
        "permissions.listSessionGrants" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let st = state.lock().await;
            Ok(json!({
                "grants": st.session_grants.get(session_id).cloned().unwrap_or_default()
            }))
        }
        "permissions.clearSessionGrants" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut st = state.lock().await;
            st.session_grants.remove(session_id);
            Ok(json!({ "ok": true }))
        }

        "plugins.list" => {
            let st = state.lock().await;
            Ok(json!({ "plugins": st.plugins.list() }))
        }
        "plugins.resolveExecution" => {
            let execution_id = params
                .get("executionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "executionId required", "INVALID_PARAMS"))?;
            let sender = {
                let mut st = state.lock().await;
                st.plugin_execs.remove(execution_id)
            };
            match sender {
                Some(sender) => {
                    let _ = sender.send(params.clone());
                    Ok(json!({ "ok": true }))
                }
                None => Err(rpc_err(1003, "unknown executionId", "NOT_FOUND")),
            }
        }
        "plugins.loadDev" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st.plugins.load_dev(path).map_err(|e| {
                let msg = e.to_string();
                if msg.contains("PLUGIN_INVALID") {
                    rpc_err(1009, msg, "PLUGIN_INVALID")
                } else {
                    rpc_err(1010, msg, "PLUGIN_LOAD_FAILED")
                }
            })?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.enable" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_enabled(id, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.disable" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_enabled(id, false)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.uninstall" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let ok = st
                .plugins
                .uninstall(id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "plugins.getPermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let plugin = st.plugins.list().into_iter().find(|p| p.id == id);
            Ok(json!({
                "permissions": plugin.map(|p| p.permissions).unwrap_or_default()
            }))
        }
        "plugins.installFromPath" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            let mut st = state.lock().await;
            let result = st
                .plugins
                .install_from_path(
                    path,
                    crate::plugins::InstallOptions {
                        source: "installed".into(),
                        enable,
                        marketplace: None,
                        expected_shasum: None,
                        auto_update: false,
                        granted_permissions: granted,
                    },
                )
                .map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "plugins.installFromPackage" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            let expected_shasum = params
                .get("expectedShasum")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut st = state.lock().await;
            let result = st
                .plugins
                .install_from_package(
                    path,
                    crate::plugins::InstallOptions {
                        source: "installed".into(),
                        enable,
                        marketplace: None,
                        expected_shasum,
                        auto_update: false,
                        granted_permissions: granted,
                    },
                )
                .map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "plugins.grantPermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let permissions = params
                .get("permissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .grant_permissions(id, permissions)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.revokePermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let permissions = params
                .get("permissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .revoke_permissions(id, permissions)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.setAutoUpdate" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let enabled = params
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_auto_update(id, enabled)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.setScope" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_scope(id, scope)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }

        "mcp.list" => {
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let servers = st
                .mcp_servers
                .list(level, project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let servers = st.mcp_servers.active_for(project_path).map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.upsert" => {
            let input: crate::mcp_servers::McpServerInput =
                serde_json::from_value(params.get("server").cloned().unwrap_or(params.clone()))
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.upsert(input).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.remove" => {
            let id = require_id(&params)?;
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let ok = st
                .mcp_servers
                .remove(&id, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "ok": ok }))
        }
        "mcp.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let server = st
                .mcp_servers
                .set_enabled(&id, enabled, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.set_scope(&id, scope).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }

        "skills.list" => {
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let skills = st
                .user_skills
                .list(level, project_path.as_deref())
                .map_err(skill_err)?;
            Ok(json!({ "skills": skills }))
        }
        "skills.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let skills = st.user_skills.active_for(project_path).map_err(skill_err)?;
            Ok(json!({ "skills": skills }))
        }
        "skills.create" => {
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.create(input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.import" => {
            let source = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?
                .to_string();
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.import(&source, input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.update" => {
            let id = require_id(&params)?;
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.update(&id, input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.read" => {
            let id = require_id(&params)?;
            let level = params
                .get("level")
                .and_then(Value::as_str)
                .map(|value| CapabilityLevel::parse(Some(value)))
                .transpose()
                .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            match st
                .user_skills
                .read(&id, level, project_path)
                .map_err(skill_err)?
            {
                Some((skill, body)) => Ok(json!({ "skill": skill, "body": body })),
                None => Ok(json!({ "skill": null, "body": null })),
            }
        }
        "skills.remove" => {
            let id = require_id(&params)?;
            let level = params
                .get("level")
                .and_then(Value::as_str)
                .map(|value| CapabilityLevel::parse(Some(value)))
                .transpose()
                .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let ok = st
                .user_skills
                .remove(&id, level, project_path)
                .map_err(skill_err)?;
            Ok(json!({ "ok": ok }))
        }
        "skills.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let skill = st
                .user_skills
                .set_enabled(&id, enabled, Some(level), project_path.as_deref())
                .map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.set_scope(&id, scope).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }

        "agents.list" => {
            let mut st = state.lock().await;
            Ok(json!({ "subagents": st.user_subagents.list().map_err(subagent_err)? }))
        }
        "agents.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            Ok(
                json!({ "subagents": st.user_subagents.active_for(project_path).map_err(subagent_err)? }),
            )
        }
        "agents.create" => {
            let input = parse_subagent_input(&params)?;
            let mut st = state.lock().await;
            let subagent = st.user_subagents.create(input).map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.update" => {
            let id = require_id(&params)?;
            let input = parse_subagent_input(&params)?;
            let mut st = state.lock().await;
            let subagent = st.user_subagents.update(&id, input).map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.read" => {
            let id = require_id(&params)?;
            let mut st = state.lock().await;
            match st.user_subagents.read(&id).map_err(subagent_err)? {
                Some((subagent, body)) => Ok(json!({ "subagent": subagent, "body": body })),
                None => Ok(json!({ "subagent": null, "body": null })),
            }
        }
        "agents.remove" => {
            let id = require_id(&params)?;
            let mut st = state.lock().await;
            let ok = st.user_subagents.remove(&id).map_err(subagent_err)?;
            Ok(json!({ "ok": ok }))
        }
        "agents.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut st = state.lock().await;
            let subagent = st
                .user_subagents
                .set_enabled(&id, enabled)
                .map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let subagent = st
                .user_subagents
                .set_scope(&id, scope)
                .map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }

        "market.refresh" => {
            let force = params
                .get("force")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let st = state.lock().await;
            let meta = st.plugins.refresh_market(force).map_err(plugin_err)?;
            Ok(meta)
        }
        "market.search" => {
            let query = params.get("query").and_then(|v| v.as_str());
            let category = params.get("category").and_then(|v| v.as_str());
            let st = state.lock().await;
            let plugins = st
                .plugins
                .market_search(query, category)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "plugins": plugins,
                "providerId": "official",
                "sourceUrl": st.plugins.market_source_url(),
            }))
        }
        "market.getDetail" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let plugin = st.plugins.market_get(id).map_err(plugin_err)?;
            Ok(json!({ "plugin": plugin }))
        }
        "market.install" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let version = params.get("version").and_then(|v| v.as_str());
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let auto_update = params
                .get("autoUpdate")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            let mut st = state.lock().await;
            let result = st
                .plugins
                .install_from_market(id, version, enable, auto_update, granted)
                .map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "market.checkUpdates" => {
            let refresh_remote = params
                .get("refreshRemote")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let mut st = state.lock().await;
            let updates = st
                .plugins
                .check_updates(refresh_remote)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "updates": updates, "plugins": st.plugins.list() }))
        }
        "market.applyUpdates" => {
            let only_auto = params
                .get("onlyAuto")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let mut st = state.lock().await;
            let results = st.plugins.apply_updates(only_auto).map_err(plugin_err)?;
            Ok(json!({ "results": results, "plugins": st.plugins.list() }))
        }

        "app.getOnboarding" => {
            let st = state.lock().await;
            let settings = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or_else(|| json!({}));
            let dismissed = settings
                .get("onboardingDismissed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let providers = providers::list_providers(&st.db, &st.secrets, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let has_provider = !providers.is_empty();
            let has_secret = providers.iter().any(|p| p.has_secret);
            let has_project = st.workspace.get().is_some();
            let session_count = sessions::session_count(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let has_session = session_count > 0;
            let steps = vec![
                json!({"id":"provider","title":"Add a model provider","done": has_provider, "action":"settings.providers"}),
                json!({"id":"secret","title":"Save your API key","done": has_secret, "action":"settings.providers"}),
                json!({"id":"project","title":"Open a project folder","done": has_project, "action":"project.open"}),
                json!({"id":"prompt","title":"Send your first prompt","done": has_session, "action":"chat.focus"}),
                json!({"id":"plugin","title":"Load a development plugin (optional)","done": !st.plugins.list().is_empty(), "action":"plugins.open"}),
            ];
            let critical_incomplete = !has_provider || !has_secret || !has_session;
            Ok(json!({
                "showChecklist": critical_incomplete && !dismissed,
                "steps": steps
            }))
        }

        "audit.append" => {
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("custom");
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let payload = params.get("payload").cloned().unwrap_or(json!({}));
            let st = state.lock().await;
            audit::append(&st.db, kind, session_id, payload)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }

        "a2a.agents.register" => {
            let params: crate::a2a::AgentsRegisterParams = a2a_params(params)?;
            let mut st = state.lock().await;
            let result = st.a2a.register(params);
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.agents.deregister" => {
            let params: crate::a2a::AgentsDeregisterParams = a2a_params(params)?;
            let (result, notifications) = {
                let mut st = state.lock().await;
                let crate::state::AppState { a2a, db, .. } = &mut *st;
                a2a.deregister(db.conn(), params).map_err(a2a_err)?
            };
            for note in &notifications {
                emit_notification(&tx, &note.method, note.params.clone()).await;
            }
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.agents.list" => {
            let params: crate::a2a::AgentsListParams = a2a_params(params)?;
            let st = state.lock().await;
            let result = st.a2a.list(params).map_err(a2a_err)?;
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.message.send" => {
            let params: crate::a2a::MessageSendParams = a2a_params(params)?;
            let (result, notifications) = {
                let mut st = state.lock().await;
                let crate::state::AppState { a2a, db, .. } = &mut *st;
                a2a.message_send(db.conn(), params).map_err(a2a_err)?
            };
            for note in &notifications {
                emit_notification(&tx, &note.method, note.params.clone()).await;
            }
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.message.stream" => {
            let params: crate::a2a::MessageStreamParams = a2a_params(params)?;
            let (result, notifications) = {
                let mut st = state.lock().await;
                let crate::state::AppState { a2a, db, .. } = &mut *st;
                a2a.message_stream(db.conn(), params).map_err(a2a_err)?
            };
            for note in &notifications {
                emit_notification(&tx, &note.method, note.params.clone()).await;
            }
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.tasks.get" => {
            let params: crate::a2a::TasksGetParams = a2a_params(params)?;
            let st = state.lock().await;
            let result = st.a2a.tasks_get(st.db.conn(), params).map_err(a2a_err)?;
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.tasks.cancel" => {
            let params: crate::a2a::TasksCancelParams = a2a_params(params)?;
            let (result, notifications) = {
                let mut st = state.lock().await;
                let crate::state::AppState { a2a, db, .. } = &mut *st;
                a2a.tasks_cancel(db.conn(), params).map_err(a2a_err)?
            };
            for note in &notifications {
                emit_notification(&tx, &note.method, note.params.clone()).await;
            }
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.tasks.status" => {
            let params: crate::a2a::TasksStatusParams = a2a_params(params)?;
            let (result, notifications) = {
                let mut st = state.lock().await;
                let crate::state::AppState { a2a, db, .. } = &mut *st;
                a2a.tasks_status(db.conn(), params).map_err(a2a_err)?
            };
            for note in &notifications {
                emit_notification(&tx, &note.method, note.params.clone()).await;
            }
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.tasks.resubscribe" => {
            let params: crate::a2a::TasksResubscribeParams = a2a_params(params)?;
            let (result, notifications) = {
                let st = state.lock().await;
                st.a2a
                    .tasks_resubscribe(st.db.conn(), params)
                    .map_err(a2a_err)?
            };
            for note in &notifications {
                emit_notification(&tx, &note.method, note.params.clone()).await;
            }
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.tasks.pushNotificationConfig.set" => {
            let params: crate::a2a::PushConfigSetParams = a2a_params(params)?;
            let st = state.lock().await;
            let result = st
                .a2a
                .push_config_set(st.db.conn(), params)
                .map_err(a2a_err)?;
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "a2a.tasks.pushNotificationConfig.get" => {
            let params: crate::a2a::PushConfigGetParams = a2a_params(params)?;
            let st = state.lock().await;
            let result = st
                .a2a
                .push_config_get(st.db.conn(), params)
                .map_err(a2a_err)?;
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }

        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use serde_json::{json, Value};
    use tokio::sync::{mpsc, Mutex};

    use super::{
        capability_err, handle_request, parse_capability_query, resolve_plan_workspace,
        resolve_tool_workspace, scope_err, skill_err,
    };
    use crate::plans::{PlanResolveParams, PlanSubmitParams};
    use crate::scheduled;
    use crate::sessions;
    use crate::state::AppState;

    #[test]
    fn capability_errors_keep_their_protocol_code() {
        let missing_project = parse_capability_query(&json!({ "level": "project" }))
            .expect_err("project queries require a project path");
        assert_eq!(
            missing_project.data.unwrap()["errorCode"],
            "CAPABILITY_INVALID"
        );

        let unknown_level = parse_capability_query(&json!({ "level": "workspace" }))
            .expect_err("unknown capability levels are invalid");
        assert_eq!(unknown_level.data.unwrap()["errorCode"], "CAPABILITY_INVALID");
        assert_eq!(scope_err("CAPABILITY_INVALID: missing project").data.unwrap()["errorCode"], "CAPABILITY_INVALID");
        assert_eq!(skill_err("CAPABILITY_INVALID: missing project").data.unwrap()["errorCode"], "CAPABILITY_INVALID");
        assert_eq!(capability_err("missing project").data.unwrap()["errorCode"], "CAPABILITY_INVALID");
    }

    fn available_test_shell_id() -> Option<String> {
        crate::tools::shell::catalog(None)
            .effective
            .map(|shell| shell.id)
    }

    fn alternate_available_test_shell_id(current: &str) -> Option<String> {
        crate::tools::shell::catalog(None)
            .choices
            .into_iter()
            .find(|shell| shell.available && shell.id != current)
            .map(|shell| shell.id)
    }

    #[cfg(windows)]
    fn sleeping_bash_command() -> &'static str {
        "Start-Sleep -Seconds 30"
    }

    #[cfg(not(windows))]
    fn sleeping_bash_command() -> &'static str {
        "sleep 30"
    }

    #[cfg(windows)]
    fn descendant_marker_bash_command(started: &Path, late: &Path) -> String {
        format!(
            "$null = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-Command',\"Start-Sleep -Milliseconds 1000; [IO.File]::WriteAllText('{}', 'late')\") -WindowStyle Hidden; [IO.File]::WriteAllText('{}', 'started'); Start-Sleep -Seconds 30",
            late.display(),
            started.display()
        )
    }

    #[cfg(not(windows))]
    fn descendant_marker_bash_command(started: &Path, late: &Path) -> String {
        format!(
            "(sleep 1; printf late > '{}') & printf started > '{}'; sleep 30",
            late.display(),
            started.display()
        )
    }

    #[cfg(windows)]
    fn output_bash_command() -> &'static str {
        "[Console]::Out.Write('out-π'); [Console]::Error.Write('err-π')"
    }

    #[cfg(not(windows))]
    fn output_bash_command() -> &'static str {
        "printf 'out-π'; printf 'err-π' >&2"
    }

    async fn wait_for_bash_registration(
        state: &Arc<Mutex<AppState>>,
        session_id: &str,
        tool_call_id: &str,
    ) {
        for _ in 0..500 {
            if state
                .lock()
                .await
                .active_bash_cancellations
                .contains_key(&(session_id.to_string(), tool_call_id.to_string()))
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("Bash cancellation was not registered");
    }

    async fn assert_bash_registry_empty(state: &Arc<Mutex<AppState>>) {
        assert!(state.lock().await.active_bash_cancellations.is_empty());
    }

    #[test]
    fn control_stdio_treats_os_resource_pressure_as_transient() {
        assert!(super::is_transient_io_error(&io::Error::from(
            io::ErrorKind::WouldBlock
        )));
        assert!(super::is_transient_io_error(&io::Error::from(
            io::ErrorKind::Interrupted
        )));
        assert!(super::is_transient_io_error(&io::Error::from_raw_os_error(
            11
        )));
        assert!(super::is_transient_io_error(&io::Error::from_raw_os_error(
            35
        )));
        assert!(!super::is_transient_io_error(&io::Error::from(
            io::ErrorKind::BrokenPipe
        )));
    }

    #[test]
    fn stdout_message_retries_partial_writes_without_duplication() {
        struct PartialWriter {
            bytes: Vec<u8>,
            blocked: bool,
        }

        impl Write for PartialWriter {
            fn write(&mut self, input: &[u8]) -> io::Result<usize> {
                if self.blocked {
                    self.blocked = false;
                    return Err(io::Error::from(io::ErrorKind::WouldBlock));
                }
                let written = input.len().min(2);
                self.bytes.extend_from_slice(&input[..written]);
                Ok(written)
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let mut writer = PartialWriter {
            bytes: Vec::new(),
            blocked: true,
        };
        assert!(super::write_stdout_message(&mut writer, "hello").is_ok());
        assert_eq!(writer.bytes, b"hello");
    }

    #[test]
    fn tool_workspace_follows_the_persisted_session_project() {
        let data_dir = tempfile::tempdir().unwrap();
        let project_a = data_dir.path().join("project-a");
        let project_b = data_dir.path().join("project-b");
        fs::create_dir_all(&project_a).unwrap();
        fs::create_dir_all(&project_b).unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();
        state.workspace.set(&project_b);
        let session = sessions::create_session(
            &state.db,
            Some("Project A".into()),
            Some("agent".into()),
            None,
            None,
            Some(project_a.to_string_lossy().into_owned()),
        )
        .unwrap();

        let resolved = PathBuf::from(
            resolve_tool_workspace(&state, &session.id)
                .unwrap()
                .unwrap(),
        );

        assert_eq!(
            resolved.canonicalize().unwrap(),
            project_a.canonicalize().unwrap()
        );
    }

    #[test]
    fn temporary_session_uses_its_own_scratch_workspace() {
        let data_dir = tempfile::tempdir().unwrap();
        let active_project = data_dir.path().join("active-project");
        fs::create_dir_all(&active_project).unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();
        state.workspace.set(&active_project);
        let session = sessions::create_session(
            &state.db,
            Some("Temporary".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();

        let resolved = PathBuf::from(
            resolve_tool_workspace(&state, &session.id)
                .unwrap()
                .unwrap(),
        );
        let expected = data_dir.path().join("scratch").join(&session.id);
        assert_eq!(resolved, expected);
        assert!(resolved.is_dir());
        assert_ne!(resolved, active_project);
        assert_eq!(
            resolve_plan_workspace(&state, &session.id)
                .expect_err("temporary sessions must not enter Plan/Goal workspaces")
                .data
                .unwrap()["errorCode"],
            "PLAN_WORKSPACE_REQUIRED"
        );
        assert_eq!(
            resolve_tool_workspace(&state, "legacy-missing-session").unwrap(),
            state.workspace.path
        );
    }

    #[tokio::test]
    async fn temporary_session_reads_and_writes_inside_its_scratch_workspace() {
        let data_dir = tempfile::tempdir().unwrap();
        let active_project = data_dir.path().join("active-project");
        fs::create_dir_all(&active_project).unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();
        state.workspace.set(&active_project);
        let session = sessions::create_session(
            &state.db,
            Some("Temporary".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let root = PathBuf::from(
            resolve_tool_workspace(&state, &session.id)
                .unwrap()
                .unwrap(),
        );
        let scratch = crate::scratch::session_dir(data_dir.path(), &session.id).unwrap();

        let written = crate::tools::execute_tool_with_path_access(
            Some(&root),
            Some(&scratch),
            "Write",
            &json!({ "path": "notes.txt", "content": "temporary" }),
            None,
            None,
            false,
        )
        .await;
        assert!(written.ok);
        assert_eq!(written.content["root"], "workspace");
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "temporary"
        );

        let read = crate::tools::execute_tool_with_path_access(
            Some(&root),
            Some(&scratch),
            "Read",
            &json!({ "path": "notes.txt" }),
            None,
            None,
            false,
        )
        .await;
        assert!(read.ok);
        assert_eq!(read.content["content"], "temporary");
        assert!(!active_project.join("notes.txt").exists());
    }

    #[tokio::test]
    async fn command_shell_settings_and_catalog_roundtrip() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();

        let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
            .await
            .unwrap();
        assert_eq!(
            settings["defaultCommandShell"],
            crate::tools::shell::default_shell_id()
        );
        assert_eq!(settings["largePasteThreshold"], 600);

        handle_request(
            state.clone(),
            "settings.set",
            json!({ "largePasteThreshold": 801 }),
            tx.clone(),
        )
        .await
        .unwrap();
        let updated = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
            .await
            .unwrap();
        assert_eq!(updated["largePasteThreshold"], 801);

        let invalid_threshold = handle_request(
            state.clone(),
            "settings.set",
            json!({ "largePasteThreshold": 0 }),
            tx.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            invalid_threshold.data.unwrap()["errorCode"],
            "INVALID_PARAMS"
        );

        let invalid = handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": "not-a-shell" }),
            tx.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(invalid.data.unwrap()["errorCode"], "COMMAND_SHELL_INVALID");

        let catalog = handle_request(state.clone(), "commandShells.list", json!({}), tx)
            .await
            .unwrap();
        assert_eq!(
            catalog["configuredId"],
            crate::tools::shell::default_shell_id()
        );
        assert!(catalog["choices"].is_array());
        assert!(catalog["effective"].is_object() || catalog["effective"].is_null());
    }

    #[tokio::test]
    async fn settings_set_preserves_stored_shell_when_shell_is_omitted() {
        let Some(current_shell) = available_test_shell_id() else {
            return;
        };
        let Some(stored_shell) = alternate_available_test_shell_id(&current_shell) else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let state = Arc::new(Mutex::new(app_state));
        let tx = mpsc::unbounded_channel().0;

        handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": stored_shell.clone() }),
            tx.clone(),
        )
        .await
        .unwrap();
        handle_request(
            state.clone(),
            "settings.set",
            json!({ "theme": "light" }),
            tx.clone(),
        )
        .await
        .unwrap();

        let settings = handle_request(state, "settings.get", json!({}), tx)
            .await
            .unwrap();
        assert_eq!(settings["defaultCommandShell"], stored_shell);
        assert_eq!(settings["theme"], "light");
    }

    #[tokio::test]
    async fn settings_set_same_shell_is_idempotent_during_an_active_turn() {
        let Some(current_shell) = available_test_shell_id() else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Active settings".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let tx = mpsc::unbounded_channel().0;
        let full_settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
            .await
            .unwrap();
        let turn_id = {
            let st = state.lock().await;
            sessions::begin_turn(&st.db, &session.id, None, None).unwrap()
        };

        let mut idempotent = full_settings;
        idempotent["defaultCommandShell"] = json!(current_shell.clone());
        idempotent["theme"] = json!("light");
        handle_request(state.clone(), "settings.set", idempotent, tx.clone())
            .await
            .unwrap();

        let settings = handle_request(state.clone(), "settings.get", json!({}), tx)
            .await
            .unwrap();
        assert_eq!(settings["defaultCommandShell"], current_shell);
        assert_eq!(settings["theme"], "light");

        let st = state.lock().await;
        sessions::end_turn(&st.db, &turn_id, "completed", None, None, false).unwrap();
    }

    #[tokio::test]
    async fn settings_set_rejects_a_genuine_shell_change_during_an_active_turn() {
        let Some(current_shell) = available_test_shell_id() else {
            return;
        };
        let Some(changed_shell) = alternate_available_test_shell_id(&current_shell) else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Shell settings".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let tx = mpsc::unbounded_channel().0;
        handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": current_shell }),
            tx.clone(),
        )
        .await
        .unwrap();
        let turn_id = {
            let st = state.lock().await;
            sessions::begin_turn(&st.db, &session.id, None, None).unwrap()
        };

        let error = handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": changed_shell }),
            tx,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.data.unwrap()["errorCode"],
            "PLAN_CONFIGURATION_BLOCKED"
        );

        let st = state.lock().await;
        sessions::end_turn(&st.db, &turn_id, "completed", None, None, false).unwrap();
    }

    #[tokio::test]
    async fn settings_set_allows_a_genuine_shell_change_when_idle() {
        let Some(current_shell) = available_test_shell_id() else {
            return;
        };
        let Some(changed_shell) = alternate_available_test_shell_id(&current_shell) else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let state = Arc::new(Mutex::new(app_state));
        let tx = mpsc::unbounded_channel().0;

        handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": current_shell }),
            tx.clone(),
        )
        .await
        .unwrap();
        handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": changed_shell.clone() }),
            tx.clone(),
        )
        .await
        .unwrap();

        let settings = handle_request(state, "settings.get", json!({}), tx)
            .await
            .unwrap();
        assert_eq!(settings["defaultCommandShell"], changed_shell);
    }

    #[tokio::test]
    async fn settings_rejects_unavailable_or_cross_platform_shell() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();
        let shell_id = crate::tools::shell::catalog(None)
            .choices
            .into_iter()
            .find(|choice| !choice.available)
            .map(|choice| choice.id)
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    crate::tools::shell::BASH_ID.into()
                } else {
                    crate::tools::shell::WINDOWS_POWERSHELL_ID.into()
                }
            });

        let error = handle_request(
            state,
            "settings.set",
            json!({ "defaultCommandShell": shell_id }),
            tx,
        )
        .await
        .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "COMMAND_SHELL_INVALID");
    }

    #[tokio::test]
    async fn default_shell_setting_is_idle_only_across_turn_and_plan_work() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let agent = sessions::create_session(
            &app_state.db,
            Some("Agent".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let active_turn = sessions::begin_turn(&app_state.db, &agent.id, None, None).unwrap();
        let Some(current_shell) = available_test_shell_id() else {
            return;
        };
        let Some(changed_shell) = alternate_available_test_shell_id(&current_shell) else {
            return;
        };
        let state = Arc::new(Mutex::new(app_state));

        let active_error = handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": changed_shell.clone() }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap_err();
        assert_eq!(
            active_error.data.unwrap()["errorCode"],
            "PLAN_CONFIGURATION_BLOCKED"
        );

        {
            let st = state.lock().await;
            sessions::end_turn(&st.db, &active_turn, "completed", None, None, false).unwrap();
        }
        handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": changed_shell.clone() }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();

        let plan = {
            let st = state.lock().await;
            let plan_session = sessions::create_session(
                &st.db,
                Some("Plan".into()),
                Some("plan".into()),
                None,
                None,
                Some(project.to_string_lossy().into_owned()),
            )
            .unwrap();
            let turn = sessions::begin_turn(&st.db, &plan_session.id, None, None).unwrap();
            let proposal = st
                .plans
                .submit(
                    &st.db,
                    PlanSubmitParams {
                        workspace_root: &project,
                        session_id: &plan_session.id,
                        turn_id: &turn,
                        tool_call_id: "submit-shell-gate",
                        kind: crate::plans::KIND_PLAN,
                        title: "Plan",
                        markdown: "# Plan",
                        question: "Proceed?",
                    },
                )
                .unwrap();
            (plan_session.id, turn, proposal)
        };

        let pending_error = handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": current_shell.clone() }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap_err();
        assert_eq!(
            pending_error.data.unwrap()["errorCode"],
            "PLAN_CONFIGURATION_BLOCKED"
        );

        let execution_id = {
            let st = state.lock().await;
            sessions::end_turn(&st.db, &plan.1, "completed", None, None, false).unwrap();
            let resolution = st
                .plans
                .resolve(
                    &st.db,
                    PlanResolveParams {
                        workspace_root: Some(&project),
                        proposal_id: &plan.2.id,
                        session_id: &plan.0,
                        turn_id: &plan.1,
                        tool_call_id: &plan.2.tool_call_id,
                        version: Some(plan.2.version),
                        action: "approve",
                        target_permission_mode: Some("ask"),
                    },
                )
                .unwrap();
            resolution.execution.unwrap().id
        };

        let queued_error = handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": current_shell.clone() }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap_err();
        assert_eq!(
            queued_error.data.unwrap()["errorCode"],
            "PLAN_CONFIGURATION_BLOCKED"
        );

        {
            let st = state.lock().await;
            st.plans.claim_execution(&st.db, &execution_id).unwrap();
        }
        let running_error = handle_request(
            state.clone(),
            "settings.set",
            json!({ "defaultCommandShell": current_shell.clone() }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap_err();
        assert_eq!(
            running_error.data.unwrap()["errorCode"],
            "PLAN_CONFIGURATION_BLOCKED"
        );

        {
            let st = state.lock().await;
            st.plans
                .finish_execution(&st.db, &execution_id, "completed", None)
                .unwrap();
        }
        handle_request(
            state,
            "settings.set",
            json!({ "defaultCommandShell": current_shell }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn bash_rejects_a_changed_shell_before_running_the_command() {
        let Some(current_shell_id) = available_test_shell_id() else {
            return;
        };
        let expected_shell_id = [
            crate::tools::shell::WINDOWS_POWERSHELL_ID,
            crate::tools::shell::CMD_ID,
            crate::tools::shell::GIT_BASH_ID,
            crate::tools::shell::BASH_ID,
        ]
        .into_iter()
        .find(|shell_id| *shell_id != current_shell_id)
        .unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let marker = project.join("must-not-run.txt");
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Shell mismatch".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();
        #[cfg(windows)]
        let command = format!("[IO.File]::WriteAllText('{}', 'ran')", marker.display());
        #[cfg(not(windows))]
        let command = format!("touch '{}'", marker.display());

        let result = handle_request(
            state,
            "tools.execute",
            json!({
                "sessionId": session.id,
                "toolCallId": "mismatch-call",
                "toolName": "Bash",
                "args": { "command": command },
                "expectedCommandShellId": expected_shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(expected_shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(result["errorCode"], "COMMAND_SHELL_CHANGED");
        assert_eq!(result["commandShellId"], current_shell_id);
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn bash_rejects_a_stale_shell_dialect_before_permission_or_spawn() {
        let Some(current_shell_id) = available_test_shell_id() else {
            return;
        };
        let current_dialect = crate::tools::shell::dialect_for_id(&current_shell_id).unwrap();
        let stale_dialect = if current_dialect == "posix" {
            "powershell"
        } else {
            "posix"
        };
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let marker = project.join("must-not-run-dialect.txt");
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Shell dialect mismatch".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let command = if cfg!(windows) {
            format!("[IO.File]::WriteAllText('{}', 'ran')", marker.display())
        } else {
            format!("touch '{}'", marker.display())
        };

        let result = handle_request(
            state,
            "tools.execute",
            json!({
                "sessionId": session.id,
                "toolCallId": "dialect-mismatch",
                "toolName": "Bash",
                "args": { "command": command },
                "expectedCommandShellId": current_shell_id,
                "expectedCommandShellDialect": stale_dialect,
                "mode": "agent"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(result["errorCode"], "COMMAND_SHELL_CHANGED");
        assert_eq!(
            result["content"]["expectedCommandShellDialect"],
            stale_dialect
        );
        assert_eq!(result["content"]["commandShellDialect"], current_dialect);
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn tools_abort_before_approval_cleans_the_cancellation_registry() {
        let Some(shell_id) = available_test_shell_id() else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Abort before approval".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("ask"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();
        let session_id = session.id.clone();
        let pending_state = state.clone();
        let pending_task = tokio::spawn(async move {
            handle_request(
                pending_state,
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": "abort-before-approval",
                    "toolName": "Bash",
                    "args": { "command": sleeping_bash_command() },
                    "expectedCommandShellId": shell_id,
                    "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                    "mode": "agent"
                }),
                tx,
            )
            .await
        });
        wait_for_bash_registration(&state, &session.id, "abort-before-approval").await;

        let aborted = handle_request(
            state.clone(),
            "tools.abort",
            json!({
                "sessionId": session.id,
                "toolCallId": "abort-before-approval"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(aborted["found"], true);
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), pending_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result["errorCode"], "TOOL_ABORTED");
        assert_eq!(result["content"]["code"], "TOOL_ABORTED");
        assert_bash_registry_empty(&state).await;

        let second = handle_request(
            state,
            "tools.abort",
            json!({
                "sessionId": session.id,
                "toolCallId": "abort-before-approval"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(second["found"], false);
    }

    #[tokio::test]
    async fn tools_abort_during_permission_removes_the_pending_request() {
        let Some(shell_id) = available_test_shell_id() else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Abort during approval".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("ask"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session_id = session.id.clone();
        let pending_state = state.clone();
        let pending_task = tokio::spawn(async move {
            handle_request(
                pending_state,
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": "abort-during-approval",
                    "toolName": "Bash",
                    "args": { "command": sleeping_bash_command() },
                    "expectedCommandShellId": shell_id,
                    "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                    "mode": "agent"
                }),
                tx,
            )
            .await
        });
        let permission = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let permission: Value = serde_json::from_str(&permission).unwrap();
        assert_eq!(permission["method"], "permissions.request");
        assert_eq!(
            permission["params"]["commandShellId"],
            crate::tools::shell::catalog(None).effective.unwrap().id
        );
        let request_id = permission["params"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();

        let aborted = handle_request(
            state.clone(),
            "tools.abort",
            json!({
                "sessionId": session.id,
                "toolCallId": "abort-during-approval"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(aborted["aborted"], true);
        let result = pending_task.await.unwrap().unwrap();
        assert_eq!(result["errorCode"], "TOOL_ABORTED");

        let late_resolution = handle_request(
            state.clone(),
            "permissions.resolve",
            json!({ "requestId": request_id, "decision": "allow-once" }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap_err();
        assert_eq!(late_resolution.data.unwrap()["errorCode"], "NOT_FOUND");
        assert_bash_registry_empty(&state).await;
    }

    #[tokio::test]
    async fn tools_abort_during_execution_kills_bash_and_cleans_registry() {
        let Some(shell_id) = available_test_shell_id() else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let started_marker = project.join("started.txt");
        let late_marker = project.join("late.txt");
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Abort execution".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();
        let started_command = descendant_marker_bash_command(&started_marker, &late_marker);
        let session_id = session.id.clone();
        let pending_state = state.clone();
        let pending_task = tokio::spawn(async move {
            handle_request(
                pending_state,
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": "abort-during-execution",
                    "toolName": "Bash",
                    "args": { "command": started_command },
                    "expectedCommandShellId": shell_id,
                    "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                    "mode": "agent"
                }),
                tx,
            )
            .await
        });
        wait_for_bash_registration(&state, &session.id, "abort-during-execution").await;
        for _ in 0..100 {
            if started_marker.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            started_marker.exists(),
            "the command should have started before abort"
        );

        let aborted = handle_request(
            state.clone(),
            "tools.abort",
            json!({
                "sessionId": session.id,
                "toolCallId": "abort-during-execution"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(aborted["found"], true);
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), pending_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result["errorCode"], "TOOL_ABORTED");
        tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
        assert!(
            !late_marker.exists(),
            "aborted descendants must not write later"
        );
        assert_bash_registry_empty(&state).await;
    }

    #[tokio::test]
    async fn bash_timeout_and_early_session_error_clean_the_registry() {
        let Some(shell_id) = available_test_shell_id() else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Timeout".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();
        let timeout_started = project.join("timeout-started.txt");
        let timeout_late = project.join("timeout-late.txt");
        let timeout_command = descendant_marker_bash_command(&timeout_started, &timeout_late);
        let timeout_result = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session.id,
                "toolCallId": "timeout-call",
                "toolName": "Bash",
                "args": { "command": timeout_command },
                "expectedCommandShellId": shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                "timeoutMs": 1000,
                "mode": "agent"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(timeout_result["errorCode"], "TOOL_TIMEOUT");
        tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
        assert!(
            !timeout_late.exists(),
            "timed-out descendants must not write later"
        );
        assert_bash_registry_empty(&state).await;

        let early = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": "missing-session",
                "toolCallId": "early-error",
                "toolName": "Bash",
                "args": { "command": sleeping_bash_command() },
                "expectedCommandShellId": shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
        .unwrap_err();
        assert_eq!(early.data.unwrap()["errorCode"], "SESSION_NOT_FOUND");
        assert_bash_registry_empty(&state).await;
    }

    #[tokio::test]
    async fn bash_output_is_streamed_with_shell_identity_and_unicode() {
        let Some(shell_id) = available_test_shell_id() else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Output".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session.id,
                "toolCallId": "output-call",
                "toolName": "Bash",
                "args": { "command": output_bash_command() },
                "expectedCommandShellId": shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["commandShellId"], shell_id);
        assert!(result["content"]["stdout"]
            .as_str()
            .unwrap()
            .contains("out-π"));
        assert!(result["content"]["stderr"]
            .as_str()
            .unwrap()
            .contains("err-π"));

        let mut streams = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            let notification: Value = serde_json::from_str(&raw).unwrap();
            if notification["method"] == "tools.output" {
                assert_eq!(notification["params"]["commandShellId"], shell_id);
                streams.push(notification["params"]["stream"].clone());
            }
        }
        assert!(streams.iter().any(|stream| stream == "stdout"));
        assert!(streams.iter().any(|stream| stream == "stderr"));
        assert_bash_registry_empty(&state).await;
    }

    #[tokio::test]
    async fn bash_mismatch_does_not_register_a_cancellation() {
        let Some(current_shell_id) = available_test_shell_id() else {
            return;
        };
        let expected_shell_id = if current_shell_id == crate::tools::shell::BASH_ID {
            crate::tools::shell::CMD_ID
        } else {
            crate::tools::shell::BASH_ID
        };
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();
        let result = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": "missing-session",
                "toolCallId": "mismatch-no-register",
                "toolName": "Bash",
                "args": { "command": "should-not-run" },
                "expectedCommandShellId": expected_shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(expected_shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(result["errorCode"], "COMMAND_SHELL_CHANGED");
        assert_bash_registry_empty(&state).await;
    }

    #[tokio::test]
    async fn plan_rpc_submits_immediately_and_roundtrips_execution_outbox() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        app_state.workspace.set(data_dir.path().join("other"));
        let session = sessions::create_session(
            &app_state.db,
            Some("Plan".into()),
            Some("plan".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let turn_id = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, mut notifications) = mpsc::unbounded_channel();
        let markdown = "  # Plan\n- implement  \n";

        let submitted = handle_request(
            state.clone(),
            "plans.submit",
            json!({
                "sessionId": session.id,
                "turnId": turn_id,
                "toolCallId": "submit-call",
                "title": "Build API",
                "markdown": markdown,
                "question": "Proceed?"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(submitted["status"], "pending");
        assert_eq!(submitted["proposal"]["title"], "Build API");
        assert_eq!(submitted["proposal"]["markdown"], markdown);
        assert_eq!(submitted["proposal"]["plan"], markdown);
        assert_eq!(submitted["proposal"]["question"], "Proceed?");
        assert_eq!(
            submitted["proposal"]["artifact"]["sizeBytes"],
            json!(markdown.len())
        );
        let artifact_path = submitted["proposal"]["artifact"]["relativePath"]
            .as_str()
            .unwrap();
        assert_eq!(
            fs::read(project.join(artifact_path)).unwrap(),
            markdown.as_bytes()
        );
        assert!(submitted["proposal"].get("expiresAt").is_some());
        let _submit_event: Value =
            serde_json::from_str(&notifications.recv().await.unwrap()).unwrap();
        let proposal_id = submitted["proposal"]["id"].as_str().unwrap();
        let version = submitted["proposal"]["version"].as_i64().unwrap();

        let configure_error = handle_request(
            state.clone(),
            "session.configure",
            json!({
                "id": session.id,
                "mode": "agent",
                "permissionMode": "auto"
            }),
            tx.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            configure_error.data.unwrap()["errorCode"],
            "PLAN_CONFIGURATION_BLOCKED"
        );

        let pending = handle_request(
            state.clone(),
            "plans.pending",
            json!({ "sessionId": session.id }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(pending["plans"].as_array().unwrap().len(), 1);

        let resolved = handle_request(
            state.clone(),
            "plans.resolve",
            json!({
                "proposalId": proposal_id,
                "sessionId": session.id,
                "turnId": turn_id,
                "toolCallId": "submit-call",
                "version": version,
                "action": "approve",
                "targetPermissionMode": "auto"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(resolved["proposal"]["status"], "approved");
        assert_eq!(resolved["execution"]["state"], "queued");
        let execution_id = resolved["execution"]["id"].as_str().unwrap();

        let queued = handle_request(
            state.clone(),
            "plans.queuedExecutions",
            json!({}),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(queued["executions"].as_array().unwrap().len(), 1);
        let claimed = handle_request(
            state.clone(),
            "plans.claimExecution",
            json!({ "executionId": execution_id }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(claimed["execution"]["state"], "running");
        let finished = handle_request(
            state,
            "plans.finishExecution",
            json!({ "executionId": execution_id, "status": "completed" }),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(finished["execution"]["state"], "completed");
    }

    #[tokio::test]
    async fn plan_enter_rpc_accepts_the_active_agent_turn() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Agent".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let turn_id = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app_state));

        let entered = handle_request(
            state.clone(),
            "plans.enter",
            json!({
                "sessionId": session.id,
                "turnId": turn_id,
                "toolCallId": "enter-call"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(entered["state"], "planning");
        assert_eq!(
            sessions::session_mode(&state.lock().await.db, &session.id)
                .unwrap()
                .as_deref(),
            Some("plan")
        );
    }

    #[tokio::test]
    async fn scheduled_run_rejects_contract_modes_before_creating_session_or_run() {
        // Plan and Goal both need a human to approve their proposal (D198), so
        // neither can be launched by the scheduler.
        for mode in ["plan", "goal"] {
            let data_dir = tempfile::tempdir().unwrap();
            let mut app_state = AppState::open(data_dir.path()).unwrap();
            app_state.handshook = true;
            let task = scheduled::create_task(
                &app_state.db,
                &json!({
                    "title": format!("{mode} schedule"),
                    "prompt": "run this",
                    "mode": mode
                }),
            )
            .unwrap();
            assert_eq!(task.mode, mode);
            app_state
                .db
                .set_setting("app", &json!({ "defaultMode": "agent" }))
                .unwrap();
            let state = Arc::new(Mutex::new(app_state));
            let (tx, _rx) = mpsc::unbounded_channel();

            let error =
                handle_request(state.clone(), "scheduled.run", json!({ "id": task.id }), tx)
                    .await
                    .unwrap_err();
            assert_eq!(
                error.data.unwrap()["errorCode"],
                "PLAN_REQUIRES_INTERACTIVE_SESSION",
                "{mode}"
            );

            let st = state.lock().await;
            let session_count: i64 = st
                .db
                .conn()
                .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
                .unwrap();
            let run_count: i64 = st
                .db
                .conn()
                .query_row("SELECT COUNT(*) FROM task_runs", [], |row| row.get(0))
                .unwrap();
            assert_eq!(session_count, 0, "{mode}");
            assert_eq!(run_count, 0, "{mode}");
        }
    }

    #[tokio::test]
    async fn scheduled_agent_task_ignores_global_plan_default() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let task = scheduled::create_task(
            &app_state.db,
            &json!({ "title": "Agent schedule", "prompt": "run this" }),
        )
        .unwrap();
        app_state
            .db
            .set_setting("app", &json!({ "defaultMode": "plan" }))
            .unwrap();
        let state = Arc::new(Mutex::new(app_state));

        let result = handle_request(
            state.clone(),
            "scheduled.run",
            json!({ "id": task.id }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(result["task"]["mode"], "agent");
        let st = state.lock().await;
        let mode = sessions::session_mode(&st.db, result["sessionId"].as_str().unwrap()).unwrap();
        assert_eq!(mode.as_deref(), Some("agent"));
        assert!(result["runId"].as_str().is_some());
    }

    #[tokio::test]
    async fn begin_turn_reports_agent_busy_without_creating_a_duplicate() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Busy".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let first = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app_state));

        let (tx, _rx) = mpsc::unbounded_channel();
        let error = handle_request(
            state.clone(),
            "session.beginTurn",
            json!({ "sessionId": session.id }),
            tx,
        )
        .await
        .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "AGENT_BUSY");

        let st = state.lock().await;
        let running: i64 = st
            .db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM turns
                 WHERE session_id = ?1 AND status = 'running'",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(running, 1);
        drop(st);
        let st = state.lock().await;
        sessions::end_turn(&st.db, &first, "aborted", None, None, false).unwrap();
    }

    /// D137: the audit row for a tool call must carry the three segments
    /// separately, so "the tool was slow" can be told apart from "the user
    /// took 20s to approve it".
    #[tokio::test]
    async fn tool_execute_audit_records_segmented_timing() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("note.txt"), "hello").unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Timing".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();

        // Read is low risk, so it auto-allows and never prompts — the run
        // therefore has a zero approval segment by construction.
        let result = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session.id,
                "toolCallId": "tc-1",
                "toolName": "Read",
                "args": { "path": "note.txt" },
                "mode": "agent"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result["ok"], json!(true), "read succeeded: {result}");

        let st = state.lock().await;
        let payload: String = st
            .db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'tool_execute' ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["toolName"], json!("Read"));
        assert_eq!(payload["prompted"], json!(false));
        // Auto-allowed, so the approval segment is bookkeeping only: assert it
        // is negligible rather than exactly zero, since a loaded test runner
        // can still spend a millisecond there.
        let permission_wait_ms = payload["permissionWaitMs"].as_u64().unwrap();
        assert!(
            permission_wait_ms < 100,
            "auto-allow does not wait: {permission_wait_ms}ms"
        );
        let execute_ms = payload["durationMs"].as_u64().unwrap();
        let overhead_ms = payload["overheadMs"].as_u64().unwrap();
        let total_ms = payload["totalMs"].as_u64().unwrap();
        assert!(
            total_ms >= execute_ms,
            "total {total_ms} covers execution {execute_ms}"
        );
        assert_eq!(
            overhead_ms,
            total_ms - execute_ms - permission_wait_ms,
            "segments add up to the total"
        );
    }

    #[tokio::test]
    async fn outside_paths_prompt_in_plan_and_auto_allows_after_mode_switch() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        let outside = data_dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("note.txt");
        fs::write(&outside_file, "outside content").unwrap();

        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("External path permission".into()),
            Some("plan".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "plan",
            None,
            None,
            None,
            Some("ask"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let request_state = state.clone();
        let session_id = session.id.clone();
        let path = outside_file.to_string_lossy().into_owned();
        let path_for_request = path.clone();
        let pending = tokio::spawn(async move {
            handle_request(
                request_state,
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": "outside-plan-read",
                    "toolName": "Read",
                    "args": { "path": path_for_request },
                    "mode": "agent"
                }),
                notify_tx,
            )
            .await
        });

        let notification = notify_rx.recv().await.unwrap();
        let notification: Value = serde_json::from_str(&notification).unwrap();
        assert_eq!(notification["method"], "permissions.request");
        assert_eq!(
            notification["params"]["reason"],
            "Accesses a path outside the session workspace"
        );
        assert_eq!(notification["params"]["argsPreview"]["path"], path);
        let request_id = notification["params"]["requestId"].as_str().unwrap();
        handle_request(
            state.clone(),
            "permissions.resolve",
            json!({ "requestId": request_id, "decision": "deny" }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        let denied = pending.await.unwrap().unwrap();
        assert_eq!(denied["ok"], false);
        assert_eq!(denied["errorCode"], "TOOL_DENIED");

        let request_state = state.clone();
        let session_id = session.id.clone();
        let path_for_request = path.clone();
        let (notify_tx2, mut notify_rx2) = mpsc::unbounded_channel();
        let allowed_pending = tokio::spawn(async move {
            handle_request(
                request_state,
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": "outside-plan-read-allowed",
                    "toolName": "Read",
                    "args": { "path": path_for_request },
                    "mode": "agent"
                }),
                notify_tx2,
            )
            .await
        });
        let notification = notify_rx2.recv().await.unwrap();
        let notification: Value = serde_json::from_str(&notification).unwrap();
        let request_id = notification["params"]["requestId"].as_str().unwrap();
        handle_request(
            state.clone(),
            "permissions.resolve",
            json!({ "requestId": request_id, "decision": "allow-once" }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        let allowed = allowed_pending.await.unwrap().unwrap();
        assert_eq!(allowed["ok"], true);
        assert_eq!(allowed["content"]["root"], "external");
        assert_eq!(allowed["content"]["content"], "outside content");

        sessions::configure_session_with_thinking(
            &state.lock().await.db,
            &session.id,
            "plan",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let auto = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session.id,
                "toolCallId": "outside-plan-auto-read",
                "toolName": "Read",
                "args": { "path": outside_file.to_string_lossy() },
                "mode": "agent"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(auto["ok"], true);
        assert_eq!(auto["content"]["root"], "external");
    }

    #[tokio::test]
    async fn delegate_permission_scope_overrides_session_mode_without_opening_external_paths() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        let outside = data_dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Delegate scope".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        // Session mode is `ask`: without a scope, Write prompts (ADR 0089).
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("ask"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let session_id = session.id.clone();
        let outside_path = outside.join("note.txt").to_string_lossy().into_owned();

        // 1. In-workspace Write under `permissionScope: accept-edits` resolves
        //    without a permission request, despite the session being in `ask`.
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let allowed = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session_id.clone(),
                "toolCallId": "delegate-write-scoped",
                "toolName": "Write",
                "args": { "path": "file.txt", "content": "delegated" },
                "mode": "agent",
                "permissionScope": "accept-edits"
            }),
            notify_tx,
        )
        .await
        .unwrap();
        assert_eq!(allowed["ok"], true);
        assert_eq!(allowed["content"]["root"], "workspace");
        // No permission request may arrive: the scope auto-allowed the write.
        // The channel is dropped with the request, so Ok(None) counts as clean.
        let stray =
            tokio::time::timeout(std::time::Duration::from_millis(100), notify_rx.recv()).await;
        match stray {
            Err(_) | Ok(None) => {}
            Ok(Some(text)) => {
                panic!("scoped in-workspace Write raised an unexpected notification: {text}")
            }
        }

        // 2. The same call without a scope prompts under the session's `ask`.
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let pending_state = state.clone();
        let pending_session_id = session_id.clone();
        let pending = tokio::spawn(async move {
            handle_request(
                pending_state,
                "tools.execute",
                json!({
                    "sessionId": pending_session_id,
                    "toolCallId": "delegate-write-unscoped",
                    "toolName": "Write",
                    "args": { "path": "file2.txt", "content": "delegated" },
                    "mode": "agent"
                }),
                notify_tx,
            )
            .await
        });
        let notification = notify_rx.recv().await.unwrap();
        let notification: Value = serde_json::from_str(&notification).unwrap();
        assert_eq!(notification["method"], "permissions.request");
        assert_eq!(
            notification["params"]["reason"],
            "Modifies files in your workspace"
        );
        let request_id = notification["params"]["requestId"].as_str().unwrap();
        handle_request(
            state.clone(),
            "permissions.resolve",
            json!({ "requestId": request_id, "decision": "allow-once" }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(pending.await.unwrap().unwrap()["ok"], true);

        // 3. An external-path Write keeps prompting even under the scope: the
        //    scope only relaxes the session mode, never the path gate.
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let pending_state = state.clone();
        let pending_session_id = session_id.clone();
        let pending_outside_path = outside_path.clone();
        let pending = tokio::spawn(async move {
            handle_request(
                pending_state,
                "tools.execute",
                json!({
                    "sessionId": pending_session_id,
                    "toolCallId": "delegate-write-external",
                    "toolName": "Write",
                    "args": { "path": pending_outside_path, "content": "delegated" },
                    "mode": "agent",
                    "permissionScope": "accept-edits"
                }),
                notify_tx,
            )
            .await
        });
        let notification = notify_rx.recv().await.unwrap();
        let notification: Value = serde_json::from_str(&notification).unwrap();
        assert_eq!(notification["method"], "permissions.request");
        assert_eq!(
            notification["params"]["reason"],
            "Accesses a path outside the session workspace"
        );
        let request_id = notification["params"]["requestId"].as_str().unwrap();
        handle_request(
            state.clone(),
            "permissions.resolve",
            json!({ "requestId": request_id, "decision": "allow-once" }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        let allowed = pending.await.unwrap().unwrap();
        assert_eq!(allowed["ok"], true);
        assert_eq!(allowed["content"]["root"], "external");
    }

    #[tokio::test]
    async fn builtin_delegate_without_permission_scope_inherits_auto_for_external_glob() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        let outside = data_dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("delegate-note.txt");
        fs::write(&outside_file, "outside content").unwrap();

        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Auto delegate external glob".into()),
            Some("agent".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let session_id = session.id.clone();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session_id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let outside_path = outside.to_string_lossy().into_owned();

        // A builtin fixer inherits the parent mode, so the same external Glob
        // that triggered the reported card is allowed in auto without a scope.
        let result = handle_request(
            state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "delegate-external-glob-auto",
                "toolName": "Glob",
                "args": { "path": outside_path, "pattern": "**/*", "limit": 10 },
                "mode": "agent"
            }),
            notify_tx,
        )
        .await
        .unwrap();
        assert_eq!(result["ok"], true, "external auto Glob failed: {result}");
        // External Glob results are absolute rather than carrying a root field.
        let canonical_outside_file = outside_file.canonicalize().unwrap();
        assert_eq!(
            result["content"]["matches"][0],
            json!(canonical_outside_file.to_string_lossy()),
        );

        let stray =
            tokio::time::timeout(std::time::Duration::from_millis(100), notify_rx.recv()).await;
        match stray {
            Err(_) | Ok(None) => {}
            Ok(Some(text)) => {
                panic!("auto external Glob raised an unexpected notification: {text}")
            }
        }
    }

    #[tokio::test]
    async fn plan_authorization_uses_durable_mode_and_keeps_bash_permission_semantics() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Plan".into()),
            Some("plan".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let session_id = session.id.clone();
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session_id,
            "plan",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();
        let command_shell_id = crate::tools::shell::default_shell_id();
        #[cfg(windows)]
        let plan_bash_command = "[Console]::Out.Write('plan-bash')";
        #[cfg(not(windows))]
        let plan_bash_command = "printf plan-bash";

        for (tool_name, args, expected) in [
            (
                "Write",
                json!({ "path": "ignored.txt", "content": "no" }),
                "WRITE_DISABLED_IN_PLAN",
            ),
            (
                "Edit",
                json!({ "path": "ignored.txt", "old_string": "a", "new_string": "b" }),
                "EDIT_DISABLED_IN_PLAN",
            ),
            ("plugin_demo_run", json!({}), "PLUGIN_DISABLED_IN_PLAN"),
            ("UnknownTool", json!({}), "TOOL_DISABLED_IN_PLAN"),
        ] {
            let result = handle_request(
                state.clone(),
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": format!("{tool_name}-call"),
                    "toolName": tool_name,
                    "args": args,
                    "mode": "agent"
                }),
                tx.clone(),
            )
            .await
            .unwrap();
            assert_eq!(result["errorCode"], expected, "{tool_name}");
            assert_eq!(result["ok"], false);
        }

        let bash = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "bash-auto",
                "toolName": "Bash",
                "args": { "command": plan_bash_command },
                "expectedCommandShellId": command_shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(command_shell_id),
                "mode": "agent"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(bash["ok"], true);
        assert_eq!(bash["content"]["stdout"], "plan-bash");

        sessions::configure_session_with_thinking(
            &state.lock().await.db,
            &session_id,
            "plan",
            None,
            None,
            None,
            Some("ask"),
        )
        .unwrap();
        #[cfg(windows)]
        let ask_bash_command = "[Console]::Out.Write('ask-bash')";
        #[cfg(not(windows))]
        let ask_bash_command = "printf ask-bash";
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let pending_state = state.clone();
        let pending_task = tokio::spawn(async move {
            handle_request(
                pending_state,
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": "bash-ask",
                    "toolName": "Bash",
                    "args": { "command": ask_bash_command },
                    "expectedCommandShellId": command_shell_id,
                    "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(command_shell_id),
                    "mode": "agent"
                }),
                notify_tx,
            )
            .await
        });
        let notification = notify_rx.recv().await.unwrap();
        let notification: Value = serde_json::from_str(&notification).unwrap();
        assert_eq!(notification["method"], "permissions.request");
        let request_id = notification["params"]["requestId"].as_str().unwrap();
        handle_request(
            state,
            "permissions.resolve",
            json!({ "requestId": request_id, "decision": "allow-once" }),
            tx,
        )
        .await
        .unwrap();
        let pending_result = pending_task.await.unwrap().unwrap();
        assert_eq!(pending_result["ok"], true);
    }

    #[tokio::test]
    async fn goal_authorization_reuses_the_durable_contract_mode_hard_deny() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Goal".into()),
            Some("goal".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let session_id = session.id.clone();
        // `auto` is the strongest permission mode; the deny must still win.
        sessions::configure_session_with_thinking(
            &app_state.db,
            &session_id,
            "goal",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();

        for (tool_name, args, expected) in [
            (
                "Write",
                json!({ "path": "ignored.txt", "content": "no" }),
                "WRITE_DISABLED_IN_PLAN",
            ),
            (
                "Edit",
                json!({ "path": "ignored.txt", "old_string": "a", "new_string": "b" }),
                "EDIT_DISABLED_IN_PLAN",
            ),
            ("plugin_demo_run", json!({}), "PLUGIN_DISABLED_IN_PLAN"),
            ("UnknownTool", json!({}), "TOOL_DISABLED_IN_PLAN"),
        ] {
            let result = handle_request(
                state.clone(),
                "tools.execute",
                json!({
                    "sessionId": session_id,
                    "toolCallId": format!("goal-{tool_name}-call"),
                    "toolName": tool_name,
                    "args": args,
                    // A sidecar claiming Agent cannot widen the durable mode.
                    "mode": "agent"
                }),
                tx.clone(),
            )
            .await
            .unwrap();
            assert_eq!(result["errorCode"], expected, "{tool_name}");
            assert_eq!(result["ok"], false);
        }

        // Bash still follows the permission mode rather than the allowlist.
        #[cfg(windows)]
        let goal_bash_command = "[Console]::Out.Write('goal-bash')";
        #[cfg(not(windows))]
        let goal_bash_command = "printf goal-bash";
        let command_shell_id = crate::tools::shell::default_shell_id();
        let bash = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "goal-bash-auto",
                "toolName": "Bash",
                "args": { "command": goal_bash_command },
                "expectedCommandShellId": command_shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(command_shell_id),
                "mode": "agent"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(bash["ok"], true);
        assert_eq!(bash["content"]["stdout"], "goal-bash");
    }

    #[tokio::test]
    async fn provider_model_cache_roundtrips_through_rpc() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();

        let created = handle_request(
            state.clone(),
            "providers.create",
            json!({
                "name": "Local catalog",
                "baseUrl": "http://localhost:11434/v1",
                "authKind": "none",
                "defaultModelId": "model-a"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        let provider_id = created["provider"]["id"].as_str().unwrap();

        let cached = handle_request(
            state.clone(),
            "providers.cacheModels",
            json!({
                "providerId": provider_id,
                "models": [
                    {
                        "modelId": "model-a",
                        "displayName": "Model A",
                        "capabilities": ["text"]
                    },
                    {
                        "modelId": "model-b",
                        "displayName": "Model B",
                        "capabilities": ["text", "reasoning"]
                    }
                ]
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(cached["cached"], 2);

        let listed = handle_request(
            state,
            "providers.listModels",
            json!({ "providerId": provider_id }),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(listed["models"].as_array().unwrap().len(), 2);
        assert_eq!(listed["models"][1]["modelId"], "model-b");
        assert_eq!(listed["models"][1]["capabilities"][1], "reasoning");
    }

    #[tokio::test]
    async fn notification_rpc_lifecycle() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("RPC task".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let turn = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
        sessions::end_turn(&app_state.db, &turn, "completed", None, None, true).unwrap();
        let visible_turn = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();

        let ended_visible = handle_request(
            state.clone(),
            "session.endTurn",
            json!({
                "turnId": visible_turn,
                "status": "completed",
                "createNotification": false
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(ended_visible, json!({ "ok": true }));

        let listed = handle_request(
            state.clone(),
            "notification.list",
            json!({ "unreadOnly": true, "limit": 10 }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(listed["unreadCount"], 1);
        assert_eq!(listed["notifications"][0]["kind"], "task.completed");
        assert_eq!(listed["notifications"][0]["sessionTitle"], "RPC task");
        let id = listed["notifications"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let marked = handle_request(
            state.clone(),
            "notification.markRead",
            json!({ "id": id }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(marked, json!({ "ok": true }));
        let marked_all = handle_request(
            state.clone(),
            "notification.markAllRead",
            json!({}),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(marked_all, json!({ "ok": true }));
        let cleared = handle_request(state.clone(), "notification.clear", json!({}), tx)
            .await
            .unwrap();
        assert_eq!(cleared, json!({ "ok": true }));

        let remaining: i64 = state
            .lock()
            .await
            .db
            .conn()
            .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
