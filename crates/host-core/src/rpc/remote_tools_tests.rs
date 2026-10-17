use super::*;

fn fixture() -> (
    tempfile::TempDir,
    Arc<Mutex<AppState>>,
    mpsc::UnboundedSender<String>,
    mpsc::UnboundedReceiver<String>,
) {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AppState::open(dir.path()).unwrap();
    state.handshook = true;
    let (tx, rx) = mpsc::unbounded_channel();
    (dir, Arc::new(Mutex::new(state)), tx, rx)
}
async fn create(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
) -> (String, String) {
    let group = handle_request(
        state.clone(),
        "project.group.createRemote",
        json!({"name":"My named project","remote":{"hostKey":"host-a","path":"/srv/work"}}),
        tx.clone(),
    )
    .await
    .unwrap();
    let path = group["group"]["primaryPath"].as_str().unwrap().to_string();
    let session = handle_request(
        state.clone(),
        "session.create",
        json!({"projectPath":path}),
        tx.clone(),
    )
    .await
    .unwrap();
    (path, session["session"]["id"].as_str().unwrap().to_string())
}
#[tokio::test]
async fn remote_project_uses_local_lifecycle_without_probing_remote_directory() {
    let (dir, state, tx, _rx) = fixture();
    let (path, id) = create(&state, &tx).await;
    assert!(path.starts_with("remote-project:"));
    let set = handle_request(
        state.clone(),
        "workspace.set",
        json!({"path":path}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(set["workspace"]["name"], "My named project");
    assert_eq!(set["workspace"]["remote"]["path"], "/srv/work");
    let listed = handle_request(state.clone(), "session.list", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(
        listed["sessions"][0]["remoteWorkspace"]["hostKey"],
        "host-a"
    );
    let detail = handle_request(state.clone(), "session.get", json!({"id":id}), tx.clone())
        .await
        .unwrap();
    assert_eq!(detail["session"]["projectPath"], path);
    assert_eq!(detail["session"]["remoteWorkspace"]["path"], "/srv/work");
    let group_id = path.strip_prefix("remote-project:").unwrap();
    let renamed = handle_request(
        state.clone(),
        "project.group.rename",
        json!({"groupId":group_id,"name":"Local name"}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(renamed["group"]["name"], "Local name");
    handle_request(
        state.clone(),
        "project.group.instructions.set",
        json!({"groupId":group_id,"content":"Keep local context"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let context = handle_request(
        state.clone(),
        "project.group.context",
        json!({"path":path}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(context["context"]["instructions"], "Keep local context");
    assert_eq!(context["context"]["remote"]["hostKey"], "host-a");
    let guard = state.lock().await;
    let scratch = resolve_plan_workspace(&guard, &id).unwrap();
    assert!(scratch.starts_with(dir.path()));
    assert!(!scratch.to_string_lossy().contains("remote-project:"));
    drop(guard);
    let removed = handle_request(
        state.clone(),
        "projects.remove",
        json!({"path":path}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(removed["sessionsRemoved"], 1);
    assert!(state
        .lock()
        .await
        .db
        .list_project_groups()
        .unwrap()
        .is_empty());
    assert!(!dir.path().join(&path).exists());
}
#[tokio::test]
async fn unregistered_remote_identity_is_rejected_before_session_or_workspace_mutation() {
    let (_dir, state, tx, _rx) = fixture();
    for method in ["session.create", "workspace.set"] {
        let params = if method == "session.create" {
            json!({"projectPath":"remote-project:unknown"})
        } else {
            json!({"path":"remote-project:unknown"})
        };
        assert!(handle_request(state.clone(), method, params, tx.clone())
            .await
            .is_err());
    }
    assert!(state.lock().await.db.list_projects().unwrap().is_empty());
}
#[tokio::test]
async fn remote_read_dispatch_is_local_approval_then_relay_never_local_runner() {
    let (_dir, state, tx, mut rx) = fixture();
    let (_path, id) = create(&state, &tx).await;
    let pending_state = state.clone();
    let pending_tx = tx.clone();
    let pending_id = id.clone();
    let pending = tokio::spawn(async move {
        handle_request(pending_state,"tools.execute",json!({"sessionId":pending_id,"toolCallId":"read-a","toolName":"Read","args":{"path":"README.md"},"mode":"agent"}),pending_tx).await
    });
    let request: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(request["method"], "tools.remoteExecute");
    assert_eq!(request["params"]["remoteWorkspace"]["path"], "/srv/work");
    handle_request(state.clone(),"tools.remoteComplete",json!({"requestId":request["params"]["requestId"],"result":{"ok":true,"content":{"text":"Remote content"}}}),tx.clone()).await.unwrap();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(result["content"]["text"], "Remote content");
    assert!(state.lock().await.remote_execs.is_empty());
}
#[tokio::test]
async fn denied_remote_write_and_cancelled_read_never_run_locally() {
    let (_dir, state, tx, mut rx) = fixture();
    let (_path, id) = create(&state, &tx).await;
    let pending_state = state.clone();
    let pending_tx = tx.clone();
    let pending_id = id.clone();
    let write = tokio::spawn(async move {
        handle_request(pending_state,"tools.execute",json!({"sessionId":pending_id,"toolCallId":"write-a","toolName":"Write","args":{"path":"a.txt","content":"value"},"mode":"agent"}),pending_tx).await
    });
    let request: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(request["method"], "permissions.request");
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({"requestId":request["params"]["requestId"],"decision":"deny"}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(write.await.unwrap().unwrap()["errorCode"], "TOOL_DENIED");
    assert!(state.lock().await.remote_execs.is_empty());
    let pending_state = state.clone();
    let pending_tx = tx.clone();
    let pending_id = id.clone();
    let read = tokio::spawn(async move {
        handle_request(pending_state,"tools.execute",json!({"sessionId":pending_id,"toolCallId":"read-b","toolName":"Read","args":{"path":"a.txt"},"mode":"agent"}),pending_tx).await
    });
    let request: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(request["method"], "tools.remoteExecute");
    handle_request(
        state.clone(),
        "tools.abort",
        json!({"sessionId":id,"toolCallId":"read-b"}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(read.await.unwrap().unwrap()["errorCode"], "TOOL_ABORTED");
    assert!(state.lock().await.remote_execs.is_empty());
}
#[tokio::test]
async fn workspace_runner_reads_without_creating_remote_project_session_or_provider_records() {
    let (dir, state, tx, _rx) = fixture();
    std::fs::write(dir.path().join("data.txt"), "remote bytes").unwrap();
    let result=handle_request(state.clone(),"tools.workspaceExecute",json!({"path":dir.path(),"sessionId":"local-owner-session","toolCallId":"read-tool","toolName":"Read","args":{"path":"data.txt"}}),tx.clone()).await.unwrap();
    assert_eq!(result["ok"], true);
    assert!(result.to_string().contains("remote bytes"));
    let guard = state.lock().await;
    assert!(guard.db.list_project_groups().unwrap().is_empty());
    assert!(sessions::list_sessions(&guard.db).unwrap().is_empty());
    assert!(guard.db.list_projects().unwrap().is_empty());
}

#[tokio::test]
async fn workspace_bash_requires_matching_shell_and_honors_abort_before_dispatch() {
    let (dir, state, tx, _rx) = fixture();
    let input = json!({"path":dir.path(),"sessionId":"local-owner","toolCallId":"bash-a","toolName":"Bash","args":{"command":"printf forbidden > should-not-exist"},"expectedCommandShellId":"wrong-shell","expectedCommandShellDialect":"wrong-dialect"});
    let result = handle_request(state.clone(), "tools.workspaceExecute", input, tx.clone())
        .await
        .unwrap();
    assert_eq!(result["errorCode"], "COMMAND_SHELL_CHANGED");
    assert!(!dir.path().join("should-not-exist").exists());
    assert!(state.lock().await.active_bash_cancellations.is_empty());
    handle_request(
        state.clone(),
        "tools.workspaceAbort",
        json!({"sessionId":"local-owner","toolCallId":"write-late"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let result=handle_request(state.clone(),"tools.workspaceExecute",json!({"path":dir.path(),"sessionId":"local-owner","toolCallId":"write-late","toolName":"Write","args":{"path":"should-not-exist","content":"forbidden"}}),tx.clone()).await.unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");
    assert!(!dir.path().join("should-not-exist").exists());
    assert!(state.lock().await.active_bash_cancellations.is_empty());
}

#[tokio::test]
async fn remote_group_binding_names_and_memory_survive_reopen() {
    let (dir, state, tx, _rx) = fixture();
    let (path, _id) = create(&state, &tx).await;
    let id = path.strip_prefix("remote-project:").unwrap();
    handle_request(state.clone(),"project.group.memory.set",json!({"groupId":id,"entries":[{"id":"entry-1","title":"API","content":"Preserve contracts"}]}),tx.clone()).await.unwrap();
    drop(state);
    let mut reloaded = AppState::open(dir.path()).unwrap();
    reloaded.handshook = true;
    let reloaded = Arc::new(Mutex::new(reloaded));
    let groups = handle_request(
        reloaded.clone(),
        "project.groups.list",
        json!({}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(groups["groups"][0]["remote"]["path"], "/srv/work");
    assert_eq!(groups["groups"][0]["name"], "My named project");
    let memory = handle_request(
        reloaded.clone(),
        "project.group.memory.get",
        json!({"groupId":id}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert!(memory.to_string().contains("Preserve contracts"));
    let duplicate = handle_request(
        reloaded.clone(),
        "project.group.createRemote",
        json!({"name":"Other name","remote":{"hostKey":"host-a","path":"/srv/work"}}),
        tx.clone(),
    )
    .await;
    assert!(duplicate.is_err());
    let other_host = handle_request(
        reloaded.clone(),
        "project.group.createRemote",
        json!({"name":"Other host","remote":{"hostKey":"host-b","path":"/srv/work"}}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_ne!(other_host["group"]["primaryPath"], path);
}

#[tokio::test]
async fn approved_remote_write_is_dispatched_only_after_local_permission_resolution() {
    let (_dir, state, tx, mut rx) = fixture();
    let (_path, id) = create(&state, &tx).await;
    let pending_state = state.clone();
    let pending_tx = tx.clone();
    let pending_id = id.clone();
    let pending = tokio::spawn(async move {
        handle_request(pending_state,"tools.execute",json!({"sessionId":pending_id,"toolCallId":"write-approved","toolName":"Write","args":{"path":"created.txt","content":"remote value"},"mode":"agent"}),pending_tx).await
    });
    let approval: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(approval["method"], "permissions.request");
    assert!(state.lock().await.remote_execs.is_empty());
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({"requestId":approval["params"]["requestId"],"decision":"allow-once"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let dispatch: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(dispatch["method"], "tools.remoteExecute");
    assert_eq!(dispatch["params"]["args"]["content"], "remote value");
    handle_request(state.clone(),"tools.remoteComplete",json!({"requestId":dispatch["params"]["requestId"],"result":{"ok":true,"content":{"path":"created.txt","root":"workspace"}}}),tx.clone()).await.unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["ok"], true);
    let rollback = handle_request(
        state.clone(),
        "review.rollback",
        json!({"sessionId":id,"snapshotId":"arbitrary"}),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        rollback.data.unwrap()["errorCode"],
        "CAPABILITY_UNAVAILABLE"
    );
}

/// ADR 0329: a remote-host project cannot host an isolated session; the
/// probe says why and creation is refused before a session exists.
#[tokio::test]
async fn remote_projects_cannot_create_isolated_sessions() {
    let (_dir, state, tx, _rx) = fixture();
    let (path, _id) = create(&state, &tx).await;
    let probe = handle_request(
        state.clone(),
        "worktree.probe",
        json!({"projectPath": path}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(probe["available"], false);
    assert_eq!(probe["errorCode"], "WORKTREE_REMOTE_UNSUPPORTED");
    let before = handle_request(state.clone(), "session.list", json!({}), tx.clone())
        .await
        .unwrap()["sessions"]
        .as_array()
        .unwrap()
        .len();
    let refused = handle_request(
        state.clone(),
        "session.create",
        json!({"projectPath": path, "isolated": true}),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused.data.unwrap()["errorCode"],
        "WORKTREE_REMOTE_UNSUPPORTED"
    );
    let after = handle_request(state.clone(), "session.list", json!({}), tx.clone())
        .await
        .unwrap()["sessions"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(before, after);
}
