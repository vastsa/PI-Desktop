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
        json!({"sessionId":id,"toolCallId":"read-b","toolName":"Read"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let abort_notification: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(abort_notification["method"], "tools.remoteAbort");
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

mod worktree_environment {
    use super::*;
    use crate::workspace_git::layout::Repository;
    use crate::workspace_git::registry::{self, SetupStatus, Variable, WorktreeRecord};

    const PROBE: &str = "printf '%s|%s|%s|%s|%s|%s|%s' \"${MY_VAR-unset}\" \"${PI_WORKTREE_ROOT-unset}\" \"${PI_PROJECT_ROOT-unset}\" \"${GIT_CONFIG_COUNT-unset}\" \"${GIT_CONFIG_KEY_0-unset}\" \"${GIT_CONFIG_VALUE_0-unset}\" \"${GIT_DIR-unset}\"";
    /// The rest of the environment-carried git configuration.
    const HARDENING_PROBE: &str = "printf '%s=[%s]|%s=[%s]|%s=[%s]|%s' \"${GIT_CONFIG_KEY_1-unset}\" \"${GIT_CONFIG_VALUE_1-unset}\" \"${GIT_CONFIG_KEY_2-unset}\" \"${GIT_CONFIG_VALUE_2-unset}\" \"${GIT_CONFIG_KEY_3-unset}\" \"${GIT_CONFIG_VALUE_3-unset}\" \"${GIT_TERMINAL_PROMPT-unset}\"";

    fn proxy() -> String {
        format!("http://127.0.0.1:4321/{}/", "ab".repeat(32))
    }

    /// What the probe prints for a variable host-core does not set: the value
    /// the Bash tool inherits from this process, or `unset`.
    fn ambient(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| "unset".to_string())
    }

    /// The probe's output for a root that is not a registered worktree: the
    /// tool environment exactly as it was before worktrees existed.
    fn untouched() -> String {
        [
            "MY_VAR",
            "PI_WORKTREE_ROOT",
            "PI_PROJECT_ROOT",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_DIR",
        ]
        .map(ambient)
        .join("|")
    }

    fn ambient_git_config() -> String {
        ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
            .map(ambient)
            .join("|")
    }

    async fn register(state: &Arc<Mutex<AppState>>, root: &Path, variables: &[(&str, &str)]) {
        let guard = state.lock().await;
        registry::insert(
            &guard.db,
            &WorktreeRecord {
                installation_id: "00000000-0000-4000-8000-000000000000".into(),
                session_id: "s-1".into(),
                repository: Repository::parse("octo", "repo").unwrap(),
                base_branch: "main".into(),
                work_branch: "pi-desktop/8b54618f6bc1".into(),
                path: root.to_string_lossy().into_owned(),
                main_path: "/w/repos/github.com/octo/repo".into(),
                base_commit: "a".repeat(40),
                created_at: "2026-11-20T00:00:00.000Z".into(),
                variables: variables
                    .iter()
                    .map(|(name, value)| Variable {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                    .collect(),
                setup_script: None,
                setup_status: SetupStatus::None,
                setup_log_tail: None,
            },
        )
        .unwrap();
    }

    /// Run the probe through `tools.workspaceExecute` and return its stdout.
    async fn probe(
        state: &Arc<Mutex<AppState>>,
        tx: &mpsc::UnboundedSender<String>,
        root: &Path,
        call: &str,
        git_proxy_url: Option<&str>,
    ) -> String {
        run(state, tx, root, call, git_proxy_url, PROBE).await
    }

    async fn run(
        state: &Arc<Mutex<AppState>>,
        tx: &mpsc::UnboundedSender<String>,
        root: &Path,
        call: &str,
        git_proxy_url: Option<&str>,
        command: &str,
    ) -> String {
        let shell = {
            let guard = state.lock().await;
            command_shell_catalog(&guard).unwrap().effective.unwrap()
        };
        let mut input = json!({
            "path": root,
            "sessionId": "local-owner",
            "toolCallId": call,
            "toolName": "Bash",
            "args": { "command": command },
            "expectedCommandShellId": shell.id,
            "expectedCommandShellDialect": shell.dialect.as_str(),
        });
        if let Some(url) = git_proxy_url {
            input["gitProxyUrl"] = json!(url);
        }
        let result = handle_request(state.clone(), "tools.workspaceExecute", input, tx.clone())
            .await
            .unwrap();
        assert_eq!(result["ok"], true, "{result}");
        result["content"]["stdout"]
            .as_str()
            .unwrap_or_else(|| panic!("no stdout in {result}"))
            .to_string()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_in_a_registered_worktree_sees_its_variables_and_roots() {
        let (dir, state, tx, _rx) = fixture();
        let root = crate::workspace::simple_canonicalize(dir.path())
            .unwrap()
            .join("wt");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        register(&state, &root, &[("MY_VAR", "from-record")]).await;
        let root_text = root.to_string_lossy().into_owned();

        let plain = probe(&state, &tx, &root, "plain", None).await;
        assert_eq!(
            plain,
            format!(
                "from-record|{root_text}|/w/repos/github.com/octo/repo|{}|{}",
                ambient_git_config(),
                ambient("GIT_DIR")
            )
        );

        let proxy = proxy();
        let proxied = probe(&state, &tx, &root.join("nested"), "proxied", Some(&proxy)).await;
        assert_eq!(
            proxied,
            format!(
                "from-record|{root_text}|/w/repos/github.com/octo/repo|4|url.{proxy}octo/repo.git.insteadOf|https://github.com/octo/repo.git|{}",
                ambient("GIT_DIR")
            )
        );
        // The host user's credential helpers, askpass program, and HTTP proxy
        // are out of the picture for the session's git.
        let hardening = run(
            &state,
            &tx,
            &root,
            "hardening",
            Some(&proxy),
            HARDENING_PROBE,
        )
        .await;
        assert_eq!(
            hardening,
            format!("credential.helper=[]|core.askPass=[]|http.{proxy}.proxy=[]|0")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_in_an_unregistered_directory_sees_none_of_it_even_with_a_proxy_url() {
        let (dir, state, tx, _rx) = fixture();
        let base = crate::workspace::simple_canonicalize(dir.path()).unwrap();
        let registered = base.join("wt");
        let other = base.join("wt-other");
        std::fs::create_dir_all(&registered).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        register(&state, &registered, &[("MY_VAR", "from-record")]).await;
        let proxy = proxy();
        for (call, url) in [("with-proxy", Some(proxy.as_str())), ("without", None)] {
            assert_eq!(probe(&state, &tx, &other, call, url).await, untouched());
        }
        // The parent of a worktree is not the worktree either.
        assert_eq!(
            probe(&state, &tx, &base, "parent", Some(&proxy)).await,
            untouched()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_stored_variable_with_a_forbidden_name_is_not_injected() {
        let (dir, state, tx, _rx) = fixture();
        let root = crate::workspace::simple_canonicalize(dir.path())
            .unwrap()
            .join("wt");
        std::fs::create_dir_all(&root).unwrap();
        register(
            &state,
            &root,
            &[
                ("GIT_DIR", "/elsewhere"),
                ("MY_VAR", "kept"),
                ("PI_WORKTREE_ROOT", "/elsewhere"),
            ],
        )
        .await;
        let root_text = root.to_string_lossy().into_owned();
        assert_eq!(
            probe(&state, &tx, &root, "forbidden", None).await,
            format!(
                "kept|{root_text}|/w/repos/github.com/octo/repo|{}|{}",
                ambient_git_config(),
                ambient("GIT_DIR")
            )
        );
    }

    #[tokio::test]
    async fn a_malformed_proxy_url_is_refused_before_the_tool_runs() {
        let (dir, state, tx, _rx) = fixture();
        for bad in [json!("https://evil.example/"), json!(7), json!("")] {
            let error = handle_request(
                state.clone(),
                "tools.workspaceExecute",
                json!({"path":dir.path(),"sessionId":"local-owner","toolCallId":"w","toolName":"Write","args":{"path":"should-not-exist","content":"x"},"gitProxyUrl":bad}),
                tx.clone(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        }
        assert!(!dir.path().join("should-not-exist").exists());
        assert!(state.lock().await.active_bash_cancellations.is_empty());
    }
}
