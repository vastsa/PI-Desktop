//! Session checklist RPC surface: `todos.get` and the `TodoWrite` tool body.
//!
//! Kept beside — not inside — the shared dispatcher so `rpc::mod` stays a
//! registration surface. Validation and persistence rules live in
//! `crate::todos`; this module owns the wire shapes, the trusted-transport
//! checks, and the after-commit `todos.changed` notification.

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::{emit_notification, rpc_err, AppState, JsonRpcError};
use crate::todos::{self, TodoRefusal, TodoSnapshot, TodoWriteError};
use crate::tools::{ToolsExecuteParams, ToolsExecuteResult};

/// Prefix of the Node-owned native Pi transcript authority (ADR 0254). Those
/// sessions live outside SQLite, so they can never own a Desktop checklist.
const NATIVE_PI_SESSION_PREFIX: &str = "native-pi:";

/// Longest `current:` excerpt carried in the tool result text. The model gets
/// the summary and the active item; it never gets the whole list echoed back.
const CURRENT_CONTENT_PREVIEW_CHARS: usize = 80;

/// `todos.get`: the committed snapshot for one live session.
pub fn get_from(state: &AppState, session_id: &str) -> Result<Value, JsonRpcError> {
    validate_session_id(session_id)?;
    let snapshot = todos::get(&state.db, session_id)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "session not found", "NOT_FOUND"))?;
    serde_json::to_value(snapshot).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
}

fn validate_session_id(session_id: &str) -> Result<(), JsonRpcError> {
    if session_id.trim().is_empty() {
        return Err(rpc_err(1002, "sessionId required", "INVALID_ARGUMENT"));
    }
    if session_id.starts_with(NATIVE_PI_SESSION_PREFIX) {
        return Err(rpc_err(
            1002,
            "native Pi sessions keep no Desktop checklist",
            "INVALID_ARGUMENT",
        ));
    }
    Ok(())
}

/// Execute one `TodoWrite` call.
///
/// The session and turn come from the trusted transport fields, never from
/// `args`, and the write is re-authorized inside the storage transaction.
/// [`todos::replace_for_turn`] returns only after the commit, so the
/// `todos.changed` snapshot below is by construction the committed one and a
/// refusal can never be observed as a state change.
pub async fn execute_write(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    p: &ToolsExecuteParams,
    started: Instant,
) -> Result<ToolsExecuteResult, JsonRpcError> {
    // A delegate's call carries its definition's permission scope (ADR 0089),
    // `inherit` included. The checklist belongs to the session's own turn, so
    // a subagent call is refused rather than attributed to the parent.
    if p.permission_scope.is_some() {
        return Ok(refused(
            p,
            "TOOL_DENIED",
            "TodoWrite is not available to delegated subagent calls",
            true,
            started,
        ));
    }

    let normalized = match todos::normalize_input(&p.args) {
        Ok(normalized) => normalized,
        Err(error) => {
            return Ok(refused(
                p,
                "INVALID_ARGUMENT",
                &error.to_string(),
                false,
                started,
            ))
        }
    };

    let committed = {
        let st = state.lock().await;
        if st.shutting_down {
            return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
        }
        todos::replace_for_turn(&st.db, &p.session_id, p.turn_id.as_deref(), &normalized)
    };
    let snapshot = match committed {
        Ok(snapshot) => snapshot,
        Err(TodoWriteError::Refused(refusal)) => {
            let (code, message, denied) = refusal_wire(refusal);
            return Ok(refused(p, code, message, denied, started));
        }
        Err(TodoWriteError::Internal(error)) => {
            return Err(rpc_err(1000, error.to_string(), "INTERNAL"))
        }
    };

    let payload = serde_json::to_value(&snapshot)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    emit_notification(tx, "todos.changed", payload).await;

    let summary = summary_of(&snapshot);
    // Identifiers, counts, and timing only: checklist text never reaches the
    // log, the audit row, or the tool result summary beyond the bounded
    // `current:` excerpt.
    tracing::info!(
        session_id = %snapshot.session_id,
        turn_id = p.turn_id.as_deref().unwrap_or(""),
        revision = snapshot.revision,
        completed = summary.completed,
        total = summary.total,
        in_progress = summary.in_progress,
        cancelled = summary.cancelled,
        warnings = normalized.warnings.len(),
        "session checklist updated"
    );

    Ok(success(
        p,
        &snapshot,
        &summary,
        &normalized.warnings,
        started,
    ))
}

fn refusal_wire(refusal: TodoRefusal) -> (&'static str, &'static str, bool) {
    match refusal {
        TodoRefusal::SessionNotFound => ("NOT_FOUND", "session not found", false),
        TodoRefusal::SessionNotAgent => (
            "TOOL_DISABLED_IN_PLAN",
            "TodoWrite requires Agent mode",
            true,
        ),
        TodoRefusal::TurnMissing => (
            "TOOL_TURN_CANCELLED",
            "TodoWrite requires the running turn of the calling session",
            false,
        ),
        TodoRefusal::TurnNotRunning => (
            "TOOL_TURN_CANCELLED",
            "the calling turn is no longer running for this session",
            false,
        ),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TodoSummary {
    completed: usize,
    total: usize,
    in_progress: usize,
    cancelled: usize,
}

/// `total` counts the items that still matter, so a cancelled item is neither
/// completed nor outstanding.
fn summary_of(snapshot: &TodoSnapshot) -> TodoSummary {
    let completed = snapshot
        .todos
        .iter()
        .filter(|item| item.status == todos::STATUS_COMPLETED)
        .count();
    let in_progress = snapshot
        .todos
        .iter()
        .filter(|item| item.status == todos::STATUS_IN_PROGRESS)
        .count();
    let cancelled = snapshot
        .todos
        .iter()
        .filter(|item| item.status == todos::STATUS_CANCELLED)
        .count();
    TodoSummary {
        completed,
        total: snapshot.todos.len().saturating_sub(cancelled),
        in_progress,
        cancelled,
    }
}

fn success(
    p: &ToolsExecuteParams,
    snapshot: &TodoSnapshot,
    summary: &TodoSummary,
    warnings: &[String],
    started: Instant,
) -> ToolsExecuteResult {
    let mut text = format!(
        "Checklist updated: {}/{} completed",
        summary.completed, summary.total
    );
    if summary.cancelled > 0 {
        text.push_str(&format!(", {} cancelled", summary.cancelled));
    }
    if let Some(current) = snapshot
        .todos
        .iter()
        .find(|item| item.status == todos::STATUS_IN_PROGRESS)
    {
        text.push_str(&format!(
            "; current: {}",
            short_single_line(&current.content, CURRENT_CONTENT_PREVIEW_CHARS)
        ));
    }
    for warning in warnings {
        text.push_str(&format!(" [{warning}]"));
    }

    ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: true,
        is_error: None,
        content: json!({
            "text": text,
            "revision": snapshot.revision,
            "summary": {
                "completed": summary.completed,
                "total": summary.total,
                "inProgress": summary.in_progress,
                "cancelled": summary.cancelled,
            },
            "warnings": warnings,
        }),
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code: None,
        command_shell_id: None,
    }
}

/// A concrete wire code for a refused call, with an explicit `isError` so a
/// model sees a fixable tool error rather than a transport failure.
fn refused(
    p: &ToolsExecuteParams,
    code: &str,
    message: &str,
    denied: bool,
    started: Instant,
) -> ToolsExecuteResult {
    ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: false,
        is_error: Some(true),
        content: json!({ "error": message, "code": code }),
        duration_ms: started.elapsed().as_millis() as u64,
        denied: denied.then_some(true),
        error_code: Some(code.to_string()),
        command_shell_id: None,
    }
}

/// Collapse whitespace and clip, so one newline-heavy item cannot inflate the
/// tool result past its single-line contract.
fn short_single_line(content: &str, max_chars: usize) -> String {
    let mut collapsed = String::with_capacity(content.len().min(max_chars));
    let mut in_whitespace = false;
    for character in content.chars() {
        if character.is_whitespace() {
            in_whitespace = true;
            continue;
        }
        if in_whitespace && !collapsed.is_empty() {
            collapsed.push(' ');
        }
        in_whitespace = false;
        collapsed.push(character);
    }
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let mut clipped: String = collapsed
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::super::{handle_request, AppState, JsonRpcError};
    use super::*;
    use crate::sessions;
    use serde_json::json;

    /// One host state with a single notification channel, so every event the
    /// calls below emit lands in one ordered stream.
    struct Harness {
        state: Arc<Mutex<AppState>>,
        tx: mpsc::UnboundedSender<String>,
        rx: mpsc::UnboundedReceiver<String>,
        _data_dir: tempfile::TempDir,
    }

    impl Harness {
        fn new() -> Self {
            let data_dir = tempfile::tempdir().unwrap();
            fs::create_dir_all(data_dir.path().join("project")).unwrap();
            let mut app_state = AppState::open(data_dir.path()).unwrap();
            app_state.handshook = true;
            let (tx, rx) = mpsc::unbounded_channel();
            Self {
                state: Arc::new(Mutex::new(app_state)),
                tx,
                rx,
                _data_dir: data_dir,
            }
        }

        async fn call(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
            handle_request(self.state.clone(), method, params, self.tx.clone()).await
        }

        async fn session(&self, mode: &str) -> String {
            let st = self.state.lock().await;
            sessions::create_session(
                &st.db,
                Some("todos".into()),
                Some(mode.into()),
                None,
                None,
                None,
            )
            .unwrap()
            .id
        }

        async fn begin_turn(&self, session_id: &str) -> String {
            let st = self.state.lock().await;
            sessions::begin_turn(&st.db, session_id, None, None).unwrap()
        }

        async fn snapshot(&self, session_id: &str) -> Value {
            self.call("todos.get", json!({ "sessionId": session_id }))
                .await
                .unwrap()
        }

        /// Every notification emitted since the last drain.
        fn events(&mut self) -> Vec<Value> {
            let mut seen = Vec::new();
            while let Ok(raw) = self.rx.try_recv() {
                seen.push(serde_json::from_str(&raw).unwrap());
            }
            seen
        }
    }

    fn write_call(session_id: &str, turn_id: &str, args: Value) -> Value {
        json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "toolCallId": "todo-1",
            "toolName": "TodoWrite",
            "args": args,
            "mode": "agent"
        })
    }

    fn items(contents: &[&str]) -> Value {
        json!({
            "todos": contents
                .iter()
                .map(|content| json!({"content": content, "status": "pending"}))
                .collect::<Vec<_>>()
        })
    }

    fn assert_refused(result: &Value, code: &str) {
        assert_eq!(result["ok"], json!(false), "{result}");
        assert_eq!(result["isError"], json!(true), "{result}");
        assert_eq!(result["errorCode"], json!(code), "{result}");
    }

    #[tokio::test]
    async fn todo_write_commits_and_emits_the_committed_snapshot_once() {
        let mut harness = Harness::new();
        let session_id = harness.session("agent").await;
        let turn_id = harness.begin_turn(&session_id).await;

        let result = harness
            .call(
                "tools.execute",
                write_call(
                    &session_id,
                    &turn_id,
                    json!({"todos": [
                        {"content": "done", "status": "completed"},
                        {"content": "now", "status": "in_progress", "priority": "high"},
                        {"content": "dropped", "status": "cancelled"}
                    ]}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(result["ok"], json!(true), "{result}");
        assert!(result.get("isError").is_none(), "{result}");
        assert_eq!(result["content"]["revision"], json!(1));
        assert_eq!(
            result["content"]["summary"],
            json!({"completed": 1, "total": 2, "inProgress": 1, "cancelled": 1})
        );
        assert_eq!(result["content"]["warnings"], json!([]));
        let text = result["content"]["text"].as_str().unwrap();
        assert!(text.contains("1/2 completed"), "{text}");
        assert!(text.contains("current: now"), "{text}");
        // The result carries a summary, never the whole checklist.
        assert!(!text.contains("dropped"), "{text}");

        let emitted = harness.events();
        assert_eq!(emitted.len(), 1, "{emitted:?}");
        assert_eq!(emitted[0]["method"], json!("todos.changed"));
        assert_eq!(emitted[0]["params"]["sessionId"], json!(session_id));
        assert_eq!(emitted[0]["params"]["revision"], json!(1));
        assert_eq!(emitted[0]["params"]["todos"].as_array().unwrap().len(), 3);
        assert!(emitted[0]["params"]["updatedAt"].as_i64().unwrap() > 0);

        // The event is exactly the committed snapshot: the read path agrees.
        assert_eq!(harness.snapshot(&session_id).await, emitted[0]["params"]);

        // A full replacement of the same list still advances the revision, so
        // a consumer can tell the two writes apart.
        let replaced = harness
            .call(
                "tools.execute",
                write_call(
                    &session_id,
                    &turn_id,
                    json!({"todos": [{"content": "done", "status": "completed"}]}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(replaced["content"]["revision"], json!(2));
        assert_eq!(
            replaced["content"]["summary"],
            json!({"completed": 1, "total": 1, "inProgress": 0, "cancelled": 0})
        );
        assert_eq!(harness.events().len(), 1);
    }

    #[tokio::test]
    async fn todo_write_reports_truncation_and_demotion_warnings() {
        let mut harness = Harness::new();
        let session_id = harness.session("agent").await;
        let turn_id = harness.begin_turn(&session_id).await;
        let long = "日".repeat(todos::MAX_TODO_CONTENT_CHARS + 5);

        let result = harness
            .call(
                "tools.execute",
                write_call(
                    &session_id,
                    &turn_id,
                    json!({"todos": [
                        {"content": long, "status": "in_progress"},
                        {"content": "multiline\nlater", "status": "in_progress"}
                    ]}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(result["ok"], json!(true), "{result}");
        let warnings = result["content"]["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0].as_str().unwrap().contains("truncated"));
        assert!(warnings[1].as_str().unwrap().contains("pending"));
        let text = result["content"]["text"].as_str().unwrap();
        assert!(!text.contains('\n'), "{text}");
        assert!(text.chars().count() < 400, "bounded text: {text}");

        let emitted = harness.events();
        assert_eq!(emitted.len(), 1);
        let stored = emitted[0]["params"]["todos"].as_array().unwrap();
        assert_eq!(
            stored[0]["content"].as_str().unwrap().chars().count(),
            todos::MAX_TODO_CONTENT_CHARS
        );
        assert_eq!(stored[1]["status"], json!("pending"));
        // Stored content keeps its own line breaks after trimming; only the
        // tool result text is collapsed to one line.
        assert_eq!(stored[1]["content"], json!("multiline\nlater"));
    }

    #[tokio::test]
    async fn refusals_never_mutate_and_never_emit() {
        let mut harness = Harness::new();
        let session_id = harness.session("agent").await;
        let turn_id = harness.begin_turn(&session_id).await;

        let first = harness
            .call(
                "tools.execute",
                write_call(&session_id, &turn_id, items(&["kept"])),
            )
            .await
            .unwrap();
        assert_eq!(first["ok"], json!(true), "{first}");
        assert_eq!(harness.events().len(), 1);
        let baseline = harness.snapshot(&session_id).await;

        // Invalid payloads are refused before anything is read or written.
        for args in [
            json!({"todos": [{"content": "x", "status": "nope"}]}),
            json!({"todos": [{"content": "x", "status": "pending", "priority": 1}]}),
            json!({"todos": [{"content": "x", "status": "pending", "priority": null}]}),
            json!({"todos": [{"content": "  ", "status": "pending"}]}),
            json!({"todos": [], "sessionId": "other-session"}),
            json!({"todos": vec![json!({"content": "x", "status": "pending"});
                todos::MAX_TODOS + 1]}),
        ] {
            let result = harness
                .call("tools.execute", write_call(&session_id, &turn_id, args))
                .await
                .unwrap();
            assert_refused(&result, "INVALID_ARGUMENT");
            assert!(harness.events().is_empty(), "a refusal emits nothing");
            assert_eq!(harness.snapshot(&session_id).await, baseline);
        }
    }

    #[tokio::test]
    async fn the_checklist_requires_agent_mode_and_an_owned_running_turn() {
        let mut harness = Harness::new();
        let session_id = harness.session("agent").await;
        let turn_id = harness.begin_turn(&session_id).await;

        // A missing, unknown, foreign, or ended turn is refused.
        let mut missing = write_call(&session_id, "", items(&["x"]));
        missing.as_object_mut().unwrap().remove("turnId");
        assert_refused(
            &harness.call("tools.execute", missing).await.unwrap(),
            "TOOL_TURN_CANCELLED",
        );
        for turn in ["unknown-turn", "another-turn"] {
            assert_refused(
                &harness
                    .call(
                        "tools.execute",
                        write_call(&session_id, turn, items(&["x"])),
                    )
                    .await
                    .unwrap(),
                "TOOL_TURN_CANCELLED",
            );
        }
        let ended = harness.session("agent").await;
        let ended_turn = harness.begin_turn(&ended).await;
        {
            let st = harness.state.lock().await;
            sessions::end_turn(&st.db, &ended_turn, "completed", None, None, false).unwrap();
        }
        assert_refused(
            &harness
                .call(
                    "tools.execute",
                    write_call(&ended, &ended_turn, items(&["x"])),
                )
                .await
                .unwrap(),
            "TOOL_TURN_CANCELLED",
        );
        // Another session's running turn cannot be borrowed.
        let other = harness.session("agent").await;
        let other_turn = harness.begin_turn(&other).await;
        assert_refused(
            &harness
                .call(
                    "tools.execute",
                    write_call(&session_id, &other_turn, items(&["x"])),
                )
                .await
                .unwrap(),
            "TOOL_TURN_CANCELLED",
        );
        assert!(harness.events().is_empty(), "no refusal emitted an event");
        assert_eq!(harness.snapshot(&session_id).await["revision"], json!(0));

        // A delegated call carries a permission scope, `inherit` included.
        for scope in ["inherit", "auto", "ask"] {
            let mut delegated = write_call(&session_id, &turn_id, items(&["x"]));
            delegated["permissionScope"] = json!(scope);
            assert_refused(
                &harness.call("tools.execute", delegated).await.unwrap(),
                "TOOL_DENIED",
            );
        }
        assert!(harness.events().is_empty());

        // Plan and Goal are denied no matter the permission mode, until the
        // approved session switches to agent.
        for mode in ["plan", "goal"] {
            let contract = harness.session(mode).await;
            assert_refused(
                &harness
                    .call(
                        "tools.execute",
                        write_call(&contract, "contract-turn", items(&["x"])),
                    )
                    .await
                    .unwrap(),
                "TOOL_DISABLED_IN_PLAN",
            );
            assert!(harness.events().is_empty(), "no event in {mode}");

            {
                let st = harness.state.lock().await;
                sessions::configure_session_with_thinking(
                    &st.db,
                    &contract,
                    "agent",
                    None,
                    None,
                    None,
                    Some("auto"),
                )
                .unwrap();
            }
            let switched_turn = harness.begin_turn(&contract).await;
            let allowed = harness
                .call(
                    "tools.execute",
                    write_call(&contract, &switched_turn, items(&["approved"])),
                )
                .await
                .unwrap();
            assert_eq!(allowed["ok"], json!(true), "{allowed}");
            assert_eq!(harness.events().len(), 1, "the switch is observable");
        }

        // A running agent turn still commits.
        let committed = harness
            .call(
                "tools.execute",
                write_call(&session_id, &turn_id, items(&["real"])),
            )
            .await
            .unwrap();
        assert_eq!(committed["ok"], json!(true), "{committed}");
    }

    #[tokio::test]
    async fn todos_get_rejects_unknown_deleted_and_native_sessions() {
        let harness = Harness::new();
        let session_id = harness.session("agent").await;

        let unknown = harness
            .call("todos.get", json!({"sessionId": "missing"}))
            .await
            .unwrap_err();
        assert_eq!(unknown.data.unwrap()["errorCode"], "NOT_FOUND");

        for invalid in ["", "   "] {
            let empty = harness
                .call("todos.get", json!({"sessionId": invalid}))
                .await
                .unwrap_err();
            assert_eq!(empty.data.unwrap()["errorCode"], "INVALID_ARGUMENT");
        }

        let native = harness
            .call("todos.get", json!({"sessionId": "native-pi:abc"}))
            .await
            .unwrap_err();
        assert_eq!(native.data.unwrap()["errorCode"], "INVALID_ARGUMENT");

        {
            let st = harness.state.lock().await;
            st.db
                .conn()
                .execute(
                    "UPDATE sessions SET deleted_at = 1 WHERE id = ?1",
                    [session_id.as_str()],
                )
                .unwrap();
        }
        let deleted = harness
            .call("todos.get", json!({"sessionId": session_id}))
            .await
            .unwrap_err();
        assert_eq!(deleted.data.unwrap()["errorCode"], "NOT_FOUND");

        // A live session that never wrote one reports an empty list at
        // revision zero.
        let fresh = harness.session("agent").await;
        let fetched = harness.snapshot(&fresh).await;
        assert_eq!(fetched["todos"], json!([]));
        assert_eq!(fetched["revision"], json!(0));
        assert_eq!(fetched["updatedAt"], json!(0));
    }

    #[tokio::test]
    async fn the_checklist_is_session_scoped_and_has_no_public_setter() {
        let mut harness = Harness::new();
        let first = harness.session("agent").await;
        let first_turn = harness.begin_turn(&first).await;
        let second = harness.session("agent").await;
        let second_turn = harness.begin_turn(&second).await;
        for (session, turn, content) in [
            (first.clone(), first_turn, "first item"),
            (second.clone(), second_turn, "second item"),
        ] {
            let result = harness
                .call(
                    "tools.execute",
                    write_call(&session, &turn, items(&[content])),
                )
                .await
                .unwrap();
            assert_eq!(result["ok"], json!(true), "{result}");
        }
        let first_snapshot = harness.snapshot(&first).await;
        assert_eq!(first_snapshot["todos"][0]["content"], json!("first item"));
        assert_eq!(first_snapshot["revision"], json!(1));
        let second_snapshot = harness.snapshot(&second).await;
        assert_eq!(second_snapshot["todos"][0]["content"], json!("second item"));

        // `todos.set` was never registered: the only writer is the tool.
        let set = harness
            .call("todos.set", json!({"sessionId": second, "todos": []}))
            .await
            .unwrap_err();
        assert_eq!(set.code, -32601);
        assert_eq!(set.data.unwrap()["errorCode"], "NOT_FOUND");
        // Drain the two committed snapshots, then prove the unknown method
        // added nothing.
        assert_eq!(harness.events().len(), 2);
        assert!(harness.events().is_empty());

        // `tools.list` advertises the tool with the low-risk declaration and
        // a strictly bounded argument object.
        let listed = harness.call("tools.list", json!({})).await.unwrap();
        let todo = listed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == json!("TodoWrite"))
            .expect("TodoWrite is advertised");
        assert_eq!(todo["risk"], json!("low"));
        assert_eq!(todo["parameters"]["required"], json!(["todos"]));
        assert_eq!(todo["parameters"]["additionalProperties"], json!(false));
        assert_eq!(
            todo["parameters"]["properties"]["todos"]["maxItems"],
            json!(50)
        );
        // Model-side validation must allow the host's truncation path.
        let content = &todo["parameters"]["properties"]["todos"]["items"]["properties"]["content"];
        assert_eq!(content["minLength"], json!(1));
        assert!(content.get("maxLength").is_none());
    }
}
