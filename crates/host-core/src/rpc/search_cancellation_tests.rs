use super::*;

struct SearchFixture {
    _data: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    session_id: String,
}

fn search_fixture() -> SearchFixture {
    let data = tempfile::tempdir().unwrap();
    let project = data.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("source.txt"), "search fixture\n").unwrap();
    let mut app = AppState::open(data.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        Some("Search cancellation fixture".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    SearchFixture {
        _data: data,
        state: Arc::new(Mutex::new(app)),
        session_id: session.id,
    }
}

async fn assert_clean(fixture: &SearchFixture, tool_call_id: &str, tool_name: &str) {
    let mut state = fixture.state.lock().await;
    assert!(state.active_bash_cancellations.is_empty());
    assert!(state.active_tool_cancellations.is_empty());
    assert!(state
        .permissions
        .pending_requests(Some(&fixture.session_id))
        .is_empty());
    let receiver = state
        .register_tool_cancellation(&fixture.session_id, tool_call_id, tool_name)
        .unwrap();
    assert!(
        !*receiver.borrow(),
        "an abort must be consumed, not retained"
    );
    state.clear_tool_cancellation(&fixture.session_id, tool_call_id, tool_name);
}

async fn execute_search(fixture: &SearchFixture, tool_name: &str, args: Value) -> Value {
    handle_request(
        fixture.state.clone(),
        "tools.execute",
        json!({
            "sessionId": fixture.session_id, "toolCallId": "next-search",
            "toolName": tool_name, "args": args, "mode": "agent",
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap()
}

async fn assert_search_consumes_early_abort(tool_name: &str, args: Value) {
    let fixture = search_fixture();
    let abort = handle_request(
        fixture.state.clone(),
        "tools.abort",
        json!({
            "sessionId": fixture.session_id, "toolCallId": "early-search", "toolName": tool_name,
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(abort["queued"], true);
    let result = handle_request(
        fixture.state.clone(),
        "tools.execute",
        json!({
            "sessionId": fixture.session_id, "toolCallId": "early-search",
            "toolName": tool_name, "args": args, "mode": "agent",
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");
    assert_eq!(result["content"]["code"], "TOOL_ABORTED");
    assert_clean(&fixture, "early-search", tool_name).await;
    let next = execute_search(&fixture, tool_name, args).await;
    assert_eq!(
        next["ok"], true,
        "a stopped call must not poison a later search"
    );
}

async fn assert_search_cancels_permission_wait(tool_name: &str, mut args: Value) {
    let fixture = search_fixture();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("outside.txt"), "search fixture\n").unwrap();
    args["path"] = json!(outside.path().to_string_lossy());
    let (tx, mut notifications) = mpsc::unbounded_channel();
    let state = fixture.state.clone();
    let params = json!({ "sessionId": fixture.session_id, "toolCallId": "approval-search",
        "toolName": tool_name, "args": args, "mode": "agent" });
    let search = tokio::spawn(async move {
        handle_request(state, "tools.execute", params, tx)
            .await
            .unwrap()
    });
    let permission = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let notification = notifications
                .recv()
                .await
                .expect("search notification channel closed");
            let notification: Value = serde_json::from_str(&notification).unwrap();
            if notification["method"] == "permissions.request" {
                break notification;
            }
        }
    })
    .await
    .expect("external-path search must still require approval");
    assert_eq!(permission["params"]["toolCallId"], "approval-search");
    handle_request(
        fixture.state.clone(),
        "tools.abort",
        json!({
            "sessionId": fixture.session_id, "toolCallId": "approval-search", "toolName": tool_name,
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), search)
        .await
        .expect("approval cancellation did not settle")
        .unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");
    assert_clean(&fixture, "approval-search", tool_name).await;
    args.as_object_mut().unwrap().remove("path");
    let next = execute_search(&fixture, tool_name, args).await;
    assert_eq!(next["ok"], true);
    assert_eq!(next["content"]["count"], 1);
}

#[tokio::test]
async fn grep_consumes_abort_before_registration_and_settles() {
    assert_search_consumes_early_abort("Grep", json!({ "pattern": "search" })).await;
}

#[tokio::test]
async fn glob_consumes_abort_before_registration_and_settles() {
    assert_search_consumes_early_abort("Glob", json!({ "pattern": "**/*.txt" })).await;
}

#[tokio::test]
async fn grep_stop_cancels_external_approval_and_cleans_registry() {
    assert_search_cancels_permission_wait("Grep", json!({ "pattern": "search" })).await;
}

#[tokio::test]
async fn glob_stop_cancels_external_approval_and_cleans_registry() {
    assert_search_cancels_permission_wait("Glob", json!({ "pattern": "**/*.txt" })).await;
}
