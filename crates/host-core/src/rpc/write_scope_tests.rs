//! Run scoped tool calls through the real RPC, permission gate and file tools.
use super::*;
use crate::session_worktrees::test_support::{init_repo, link_dir, try_link_file};
use std::fs;

struct Fixture {
    _dir: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    root: PathBuf,
    session_id: String,
}

impl Fixture {
    async fn new(isolated: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        if isolated {
            init_repo(&root);
        } else {
            fs::create_dir(&root).unwrap();
        }
        let mut app = AppState::open(&dir.path().join("data")).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        let session = handle_request(
            state.clone(),
            "session.create",
            json!({"projectPath":root,"isolated":isolated}),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        let fixture = Self {
            _dir: dir,
            state,
            // Use the address advertised to the delegate, not a temp-root
            // alias (Windows TEMP may use a DOS 8.3 user directory name).
            root: PathBuf::from(session["session"]["projectPath"].as_str().unwrap()),
            session_id: session["session"]["id"].as_str().unwrap().to_owned(),
        };
        fixture.configure("agent", "auto").await;
        fixture
    }

    async fn configure(&self, mode: &str, permission: &str) {
        sessions::configure_session_with_thinking(
            &self.state.lock().await.db,
            &self.session_id,
            mode,
            None,
            None,
            None,
            Some(permission),
        )
        .unwrap();
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
        handle_request(
            self.state.clone(),
            method,
            params,
            mpsc::unbounded_channel().0,
        )
        .await
    }

    fn tool_params(&self, name: &str, args: Value, scope: Option<Value>) -> Value {
        let mut params = json!({
            "sessionId":self.session_id,"toolCallId":uuid::Uuid::new_v4(),
            "mode":"agent","toolName":name,"args":args,
        });
        if let Some(scope) = scope {
            params["writeScope"] = scope;
        }
        params
    }

    async fn tool(&self, name: &str, args: Value, scope: Option<Value>) -> Value {
        self.rpc("tools.execute", self.tool_params(name, args, scope))
            .await
            .unwrap()
    }

    async fn write(&self, path: impl AsRef<Path>, scope: Option<Value>) -> Value {
        self.tool(
            "Write",
            json!({"path":path.as_ref(),"content":"new\n"}),
            scope,
        )
        .await
    }
}

fn assert_scope_denied(result: Value) {
    assert_eq!(result["errorCode"], "WRITE_SCOPE_VIOLATION", "{result}");
    assert_eq!(result["denied"], true, "{result}");
}

#[tokio::test]
async fn write_scope_is_call_local_and_omission_preserves_unscoped_tools() {
    let f = Fixture::new(false).await;
    let a = Some(json!(["area-a/"]));
    let b = Some(json!(["area-ab"]));
    let accepted = f.write("./area-a/sub/../a.txt", a.clone()).await;
    assert_eq!(accepted["ok"], true, "{accepted}");
    assert_scope_denied(f.write("area-ab/b.txt", a.clone()).await);
    assert_scope_denied(f.write("area-a/../elsewhere.txt", a).await);
    assert_scope_denied(f.write("area-a/a.txt", b.clone()).await);
    let accepted = f.write("area-ab/b.txt", b).await;
    assert_eq!(accepted["ok"], true, "{accepted}");
    assert_scope_denied(f.write("empty.txt", Some(json!([]))).await);
    let unscoped = f.write("elsewhere.txt", None).await;
    assert_eq!(unscoped["ok"], true, "{unscoped}");
    assert_eq!(
        fs::read_to_string(f.root.join("area-a/a.txt")).unwrap(),
        "new\n"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("area-ab/b.txt")).unwrap(),
        "new\n"
    );
    assert!(!f.root.join("empty.txt").exists());
    // An exact file grant cannot create a missing parent outside the grant.
    assert_scope_denied(
        f.write("unlisted/new.txt", Some(json!(["unlisted/new.txt"])))
            .await,
    );
    assert!(!f.root.join("unlisted").exists());
}

#[tokio::test]
async fn write_scope_checks_actual_edit_source_and_move_destination_before_mutation() {
    let f = Fixture::new(false).await;
    let scope = Some(json!([f.root.join("allowed")]));
    let write = f.write("allowed/source.txt", scope.clone()).await;
    assert_eq!(write["ok"], true, "{write}");
    fs::write(f.root.join("outside.txt"), "outside\n").unwrap();
    let args = |ops| json!({"path":"allowed/source.txt","tag":write["content"]["tag"],"ops":ops});
    assert_scope_denied(
        f.tool(
            "Edit",
            args("PUT 1.=1:\n+changed\nMV allowed/../outside.txt"),
            scope.clone(),
        )
        .await,
    );
    assert_scope_denied(
        f.tool("Edit", args("MV outside-dir/new.txt"), scope.clone())
            .await,
    );
    assert_scope_denied(
        f.tool(
            "Edit",
            json!({"path":"outside.txt","old_string":"outside","new_string":"forbidden"}),
            scope.clone(),
        )
        .await,
    );
    assert_eq!(
        fs::read_to_string(f.root.join("outside.txt")).unwrap(),
        "outside\n"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("allowed/source.txt")).unwrap(),
        "new\n"
    );
    let edited = f
        .tool("Edit", args("PUT 1.=1:\n+inside"), scope.clone())
        .await;
    assert_eq!(edited["ok"], true, "{edited}");
    assert!(!f.root.join("outside-dir").exists());
    let moved = f
        .tool("Edit", json!({"path":"allowed/source.txt","tag":edited["content"]["tag"],"ops":"MV allowed/renamed.txt"}), scope.clone())
        .await;
    assert_eq!(moved["ok"], true, "{moved}");
    assert!(!f.root.join("allowed/source.txt").exists());
    let deleted = f
        .tool(
            "Edit",
            json!({"path":"allowed/renamed.txt","tag":moved["content"]["tag"],"ops":"REM"}),
            scope,
        )
        .await;
    assert_eq!(deleted["ok"], true, "{deleted}");
    assert!(!f.root.join("allowed/renamed.txt").exists());
}

#[tokio::test]
async fn write_scope_blocks_symbolic_and_hard_links_to_unlisted_paths() {
    let f = Fixture::new(false).await;
    let allowed = f.root.join("allowed");
    let outside = f.root.join("outside");
    fs::create_dir(&allowed).unwrap();
    fs::create_dir(&outside).unwrap();
    let victim = outside.join("victim.txt");
    fs::write(&victim, "outside\n").unwrap();
    link_dir(&outside, &allowed.join("junction"));
    let scope = Some(json!(["allowed"]));
    assert_scope_denied(f.write("allowed/junction/victim.txt", scope.clone()).await);
    assert_scope_denied(f.write("allowed/junction/new.txt", scope.clone()).await);
    assert_scope_denied(
        f.write(
            "allowed/junction/victim.txt",
            Some(json!(["allowed/junction"])),
        )
        .await,
    );
    let dangling = allowed.join("dangling.txt");
    if try_link_file(&outside.join("missing.txt"), &dangling) {
        assert_scope_denied(f.write("allowed/dangling.txt", scope.clone()).await);
        assert!(!outside.join("missing.txt").exists());
    }
    fs::hard_link(&victim, allowed.join("hard.txt")).unwrap();
    assert_scope_denied(f.write("allowed/hard.txt", scope.clone()).await);
    let source = f.write("allowed/source.txt", scope.clone()).await;
    assert_eq!(source["ok"], true, "{source}");
    for dest in ["allowed/junction/victim.txt", "allowed/hard.txt"] {
        let result = f.tool("Edit", json!({"path":"allowed/source.txt","tag":source["content"]["tag"],"ops":format!("MV {dest}")}), scope.clone()).await;
        assert_scope_denied(result);
    }
    assert_eq!(fs::read_to_string(&victim).unwrap(), "outside\n");
    assert_eq!(
        fs::read_to_string(allowed.join("source.txt")).unwrap(),
        "new\n"
    );
    assert!(!outside.join("new.txt").exists());
}

#[tokio::test]
async fn write_scope_does_not_turn_into_permission_or_an_unscoped_invalid_request() {
    let f = Fixture::new(false).await;
    for invalid in [
        json!(null),
        json!(false),
        json!([""]),
        json!([" "]),
        json!([1]),
    ] {
        let result = f
            .rpc(
                "tools.execute",
                f.tool_params(
                    "Write",
                    json!({"path":"bad.txt","content":"bad"}),
                    Some(invalid),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(result.data.unwrap()["errorCode"], "INVALID_PARAMS");
    }
    let result = f
        .rpc(
            "tools.execute",
            f.tool_params("Bash", json!({}), Some(json!(["."]))),
        )
        .await
        .unwrap_err();
    assert_eq!(result.data.unwrap()["errorCode"], "INVALID_PARAMS");
    assert!(!f.root.join("bad.txt").exists());
    f.configure("plan", "auto").await;
    let result = f.write("blocked.txt", Some(json!(["."]))).await;
    assert_eq!(result["errorCode"], "WRITE_DISABLED_IN_PLAN", "{result}");
    assert!(!f.root.join("blocked.txt").exists());
}

#[tokio::test]
async fn write_scope_never_replaces_approval_and_approval_never_replaces_scope() {
    let f = Fixture::new(false).await;
    f.configure("agent", "ask").await;
    for (path, decision, expected) in [
        ("allowed/denied.txt", "deny", "TOOL_DENIED"),
        ("outside.txt", "allow-session", "WRITE_SCOPE_VIOLATION"),
    ] {
        let params = f.tool_params(
            "Write",
            json!({"path":path,"content":"new"}),
            Some(json!(["allowed"])),
        );
        let (tx, mut rx) = mpsc::unbounded_channel();
        let call = tokio::spawn(handle_request(f.state.clone(), "tools.execute", params, tx));
        let notification = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let request: Value = serde_json::from_str(&notification).unwrap();
        assert_eq!(request["method"], "permissions.request");
        assert!(!f.root.join(path).exists());
        f.rpc(
            "permissions.resolve",
            json!({"requestId":request["params"]["requestId"],"decision":decision}),
        )
        .await
        .unwrap();
        let result = call.await.unwrap().unwrap();
        assert_eq!(result["errorCode"], expected, "{result}");
        assert!(!f.root.join(path).exists());
    }
    assert!(f.state.lock().await.session_grants.is_empty());

    let params = f.tool_params(
        "Write",
        json!({"path":"allowed/stale.txt","content":"new"}),
        Some(json!(["allowed"])),
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    let call = tokio::spawn(handle_request(f.state.clone(), "tools.execute", params, tx));
    let notification = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let request: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(request["method"], "permissions.request");
    f.configure("plan", "auto").await;
    f.rpc(
        "permissions.resolve",
        json!({"requestId":request["params"]["requestId"],"decision":"allow-once"}),
    )
    .await
    .unwrap();
    let result = call.await.unwrap().unwrap_err();
    assert_eq!(result.data.unwrap()["errorCode"], "TOOL_CONTEXT_CHANGED");
    assert!(!f.root.join("allowed/stale.txt").exists());
}

#[tokio::test]
async fn write_scope_does_not_initialize_contained_roots_when_refused() {
    let f = Fixture::new(false).await;
    let (scratch, visualization) = {
        let st = f.state.lock().await;
        (
            scratch::session_dir(&st.data_dir, &f.session_id).unwrap(),
            visualizations::session_dir(&st.data_dir, &f.session_id).unwrap(),
        )
    };
    for dir in [scratch, visualization] {
        let path = dir.join("outside.html");
        assert_scope_denied(f.write(&path, Some(json!([path]))).await);
        assert!(!dir.exists());
    }
}

#[tokio::test]
async fn write_scope_requires_the_verified_delegate_worktree_and_stays_inside_it() {
    let f = Fixture::new(true).await;
    let base = f.tool_params(
        "Write",
        json!({"path":"source.txt","content":"delegate contents"}),
        Some(json!(["."])),
    );
    let mut unknown = base.clone();
    unknown["delegationId"] = json!("unknown-chain");
    for invalid in [base.clone(), unknown] {
        assert!(f.rpc("tools.execute", invalid).await.is_err());
    }
    let delegation = "scoped-chain";
    f.rpc(
        "worktree.delegate.create",
        json!({"sessionId":f.session_id,"delegationId":delegation}),
    )
    .await
    .unwrap();
    let (session_root, delegate_root) = {
        let st = f.state.lock().await;
        (
            crate::session_worktrees::lifecycle::tool_root(&st.db, &f.session_id)
                .unwrap()
                .unwrap(),
            crate::session_worktrees::delegate::tool_root(&st.db, &f.session_id, Some(delegation))
                .unwrap()
                .unwrap(),
        )
    };
    let mut call = base;
    call["delegationId"] = json!(delegation);
    let result = f.rpc("tools.execute", call.clone()).await.unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(
        fs::read_to_string(delegate_root.join("source.txt")).unwrap(),
        "delegate contents"
    );
    assert!(!session_root.join("source.txt").exists());
    assert!(!f.root.join("source.txt").exists());

    let git_link = fs::read_to_string(delegate_root.join(".git")).unwrap();
    let mut metadata_call = call.clone();
    metadata_call["args"]["path"] = json!(".git");
    assert_scope_denied(f.rpc("tools.execute", metadata_call).await.unwrap());
    assert_eq!(
        fs::read_to_string(delegate_root.join(".git")).unwrap(),
        git_link
    );

    let project_target = f.root.join("source.txt");
    call["args"]["path"] = json!(project_target);
    call["writeScope"] = json!([project_target]);
    assert_scope_denied(f.rpc("tools.execute", call).await.unwrap());
    assert!(!project_target.exists());

    fs::remove_file(delegate_root.join(".git")).unwrap();
    let mut missing_link = f.tool_params(
        "Write",
        json!({"path":"unverified.txt","content":"not written"}),
        Some(json!(["."])),
    );
    missing_link["delegationId"] = json!(delegation);
    let error = f.rpc("tools.execute", missing_link).await.unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "WRITE_SCOPE_UNAVAILABLE");
    assert!(!delegate_root.join("unverified.txt").exists());
}
