//! Session visualization root (D671): containment, `.html`-only writes,
//! prompting, review exclusion, and lifecycle.

use super::*;
use std::fs;

mod fork;
fn options(visualization_root: Option<&Path>) -> tools::ToolExecutionOptions<'_> {
    tools::ToolExecutionOptions {
        timeout_ms: None,
        bash_options: None,
        allow_external_paths: false,
        hashline: None,
        visualization_root,
    }
}

struct Fixture {
    _data: tempfile::TempDir,
    data_dir: PathBuf,
    workspace: PathBuf,
    scratch: PathBuf,
    visualization: PathBuf,
}

fn fixture() -> Fixture {
    let data = tempfile::tempdir().unwrap();
    // Canonical paths keep the symlink-aware resolver's comparisons simple on
    // macOS, where the temp dir lives behind /var -> /private/var.
    let data_dir = workspace::simple_canonicalize(data.path()).unwrap();
    let workspace = data_dir.join("project");
    fs::create_dir_all(&workspace).unwrap();
    let scratch = scratch::session_dir(&data_dir, "s1").unwrap();
    let visualization = visualizations::session_dir(&data_dir, "s1").unwrap();
    Fixture {
        _data: data,
        data_dir,
        workspace,
        scratch,
        visualization,
    }
}

#[test]
fn redirected_visualization_roots_never_skip_authorization() {
    for redirect_base in [false, true] {
        let f = fixture();
        // Keep the root list across replacement: it is not a cached grant.
        let roots = local_contained_roots(&f.data_dir, "s1", false);
        let link = if redirect_base {
            visualizations::base_dir(&f.data_dir)
        } else {
            fs::create_dir_all(visualizations::base_dir(&f.data_dir)).unwrap();
            f.visualization.clone()
        };
        crate::session_worktrees::test_support::link_dir(&f.workspace, &link);
        let args = json!({ "path": f.visualization.join("index.html"), "content": "overwrite" });
        for ws in [&f.workspace, &f.data_dir] {
            assert!(!contained_write_auto_allowed(
                false, "agent", &roots, "Write", &args
            ));
            assert!(requires_external_path_permission(
                Some(&ws.to_string_lossy()),
                &roots,
                "Read",
                &args
            ));
            assert!(requires_external_path_permission(
                Some(&ws.to_string_lossy()),
                &roots,
                "Write",
                &args
            ));
        }
        let scratch_args = json!({
            "path": f.scratch.join("notes.txt"),
            "ops": format!("MV {}", f.visualization.join("index.html").display()),
        });
        assert!(!contained_write_auto_allowed(
            false,
            "agent",
            &roots,
            "Edit",
            &scratch_args
        ));
    }
}

#[tokio::test]
async fn execution_rejects_redirected_roots_and_does_not_create_external_directories() {
    for redirect_base in [false, true] {
        for contains_data in [false, true] {
            let f = fixture();
            let roots = local_contained_roots(&f.data_dir, "s1", false);
            fs::create_dir_all(&f.visualization).unwrap();
            let link = if redirect_base {
                visualizations::base_dir(&f.data_dir)
            } else {
                f.visualization.clone()
            };
            fs::rename(&link, f.data_dir.join("previous-root")).unwrap();
            crate::session_worktrees::test_support::link_dir(&f.workspace, &link);
            let ws = if contains_data {
                &f.data_dir
            } else {
                &f.workspace
            };
            let path = f.visualization.join("index.html");
            assert!(workspace::resolve_tool_path(ws, &roots, &path.to_string_lossy()).is_err());
            let written = tools::execute_tool_with_path_access(
                Some(ws),
                Some(&f.scratch),
                "Write",
                &json!({ "path": path, "content": "overwrite" }),
                options(Some(&f.visualization)),
            )
            .await;
            assert!(!written.ok, "redirected root must not execute: {written:?}");
            assert!(!f.workspace.join("index.html").exists());
            assert!(
                !f.workspace.join("s1").exists(),
                "lazy creation followed the base link"
            );
        }
    }
}

async fn rpc_session(
    f: &Fixture,
    contains_data: bool,
    permission_mode: &str,
) -> (Arc<Mutex<AppState>>, String) {
    let mut app = AppState::open(&f.data_dir).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let project = if contains_data {
        &f.data_dir
    } else {
        &f.workspace
    };
    let created = handle_request(
        state.clone(),
        "session.create",
        json!({ "projectPath": project }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap().to_string();
    handle_request(
        state.clone(),
        "session.configure",
        json!({ "id": id, "mode": "agent", "permissionMode": permission_mode }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    (state, id)
}

#[tokio::test]
async fn rpc_redirected_visualization_write_prompts_and_denial_preserves_project() {
    for redirect_base in [false, true] {
        for contains_data in [false, true] {
            let f = fixture();
            let (state, id) = rpc_session(&f, contains_data, "ask").await;
            let root = visualizations::session_dir(&f.data_dir, &id).unwrap();
            let target = if redirect_base {
                f.workspace.join(&id)
            } else {
                f.workspace.clone()
            };
            fs::create_dir_all(&target).unwrap();
            fs::write(target.join("index.html"), "important project file").unwrap();
            let link = if redirect_base {
                visualizations::base_dir(&f.data_dir)
            } else {
                fs::create_dir_all(visualizations::base_dir(&f.data_dir)).unwrap();
                root.clone()
            };
            crate::session_worktrees::test_support::link_dir(&f.workspace, &link);
            let (tx, mut rx) = mpsc::unbounded_channel();
            let pending_state = state.clone();
            let params = json!({ "sessionId": id, "toolCallId": "redirected-write", "toolName": "Write",
                "args": { "path": root.join("index.html"), "content": "overwrite" }, "mode": "agent" });
            let mut pending = tokio::spawn(handle_request(
                pending_state,
                "tools.execute",
                params,
                tx.clone(),
            ));
            let permission: Value = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::select! {
                    note = rx.recv() => serde_json::from_str(&note.unwrap()).unwrap(),
                    result = &mut pending => panic!("redirected Write completed without approval: {result:?}"),
                }
            }).await.unwrap();
            assert_eq!(permission["method"], "permissions.request");
            assert_eq!(
                fs::read_to_string(target.join("index.html")).unwrap(),
                "important project file"
            );
            handle_request(
                state.clone(),
                "permissions.resolve",
                json!({ "requestId": permission["params"]["requestId"], "decision": "deny" }),
                tx,
            )
            .await
            .unwrap();
            assert_eq!(pending.await.unwrap().unwrap()["errorCode"], "TOOL_DENIED");
            assert_eq!(
                fs::read_to_string(target.join("index.html")).unwrap(),
                "important project file"
            );
        }
    }
}

// Runs without platform gating, including Windows where std canonicalize
// returns a drive prefix that the tool resolver deliberately strips.
#[tokio::test]
async fn rpc_direct_html_write_read_edit_user_path_uses_one_canonical_spelling() {
    let f = fixture();
    let (state, id) = rpc_session(&f, false, "ask").await;
    let root = visualizations::session_dir(&f.data_dir, &id).unwrap();
    let path = root.join("chart.html");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let write = handle_request(
        state.clone(),
        "tools.execute",
        json!({ "sessionId": id, "toolCallId": "write", "toolName": "Write",
            "args": { "path": path, "content": "<p>before</p>" }, "mode": "agent" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(write["ok"], true, "{write}");
    assert_eq!(write["content"]["root"], "visualization");
    assert!(write["content"].get("review").is_none());
    let read = handle_request(
        state.clone(),
        "tools.execute",
        json!({ "sessionId": id, "toolCallId": "read", "toolName": "Read",
            "args": { "path": path }, "mode": "agent" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(read["ok"], true, "{read}");
    let resolved = PathBuf::from(read["content"]["path"].as_str().unwrap());
    assert_eq!(
        resolved.parent(),
        Some(workspace::simple_canonicalize(&root).unwrap().as_path())
    );
    let edited = handle_request(state.clone(), "tools.execute",
        json!({ "sessionId": id, "toolCallId": "edit", "toolName": "Edit",
            "args": { "path": path, "tag": read["content"]["tag"], "ops": "PUT 1.=1:\n+<p>after</p>" },
            "mode": "agent" }), tx,
    ).await.unwrap();
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["content"]["root"], "visualization");
    assert!(edited["content"].get("review").is_none());
    assert_eq!(fs::read_to_string(&path).unwrap(), "<p>after</p>");
    while let Ok(note) = rx.try_recv() {
        let note: Value = serde_json::from_str(&note).unwrap();
        assert_ne!(note["method"], "permissions.request");
    }
}

#[tokio::test]
async fn rpc_session_delete_and_project_removal_do_not_follow_a_redirected_base() {
    for remove_project in [false, true] {
        let f = fixture();
        let (state, id) = rpc_session(&f, false, "ask").await;
        let external = f.workspace.join("important");
        let keep = external.join(&id).join("keep.html");
        fs::create_dir_all(keep.parent().unwrap()).unwrap();
        fs::write(&keep, "irreplaceable").unwrap();
        crate::session_worktrees::test_support::link_dir(
            &external,
            &visualizations::base_dir(&f.data_dir),
        );
        let (method, params) = if remove_project {
            ("projects.remove", json!({ "path": f.workspace }))
        } else {
            ("session.delete", json!({ "id": id }))
        };
        handle_request(state, method, params, mpsc::unbounded_channel().0)
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(keep).unwrap(), "irreplaceable");
    }
}

async fn run(f: &Fixture, tool: &str, args: Value) -> tools::ToolsExecuteResult {
    tools::execute_tool_with_path_access(
        Some(&f.workspace),
        Some(&f.scratch),
        tool,
        &args,
        options(Some(&f.visualization)),
    )
    .await
}

#[tokio::test]
async fn writes_and_reads_html_fragments_in_the_visualization_root() {
    let f = fixture();
    let card = f.visualization.join("chart.html");
    let written = run(
        &f,
        "Write",
        json!({ "path": card.to_string_lossy(), "content": "<p>hi</p>" }),
    )
    .await;
    assert!(written.ok, "{:?}", written.content);
    assert_eq!(written.content["root"], "visualization");
    assert_eq!(fs::read_to_string(&card).unwrap(), "<p>hi</p>");

    let read = run(&f, "Read", json!({ "path": card.to_string_lossy() })).await;
    assert!(read.ok, "{:?}", read.content);
    assert_eq!(read.content["root"], "visualization");
}

#[tokio::test]
async fn rejects_non_html_writes_in_the_visualization_root() {
    let f = fixture();
    let script = f.visualization.join("evil.js");
    let written = run(
        &f,
        "Write",
        json!({ "path": script.to_string_lossy(), "content": "x" }),
    )
    .await;
    assert!(!written.ok);
    assert_eq!(
        written.error_code.as_deref(),
        Some("VISUALIZATION_HTML_ONLY")
    );
    assert!(!script.exists());

    // Nested paths are unreachable by the card URL, so they are refused too.
    let nested = f.visualization.join("sub").join("chart.html");
    let nested_write = run(
        &f,
        "Write",
        json!({ "path": nested.to_string_lossy(), "content": "<p>x</p>" }),
    )
    .await;
    assert_eq!(
        nested_write.error_code.as_deref(),
        Some("VISUALIZATION_HTML_ONLY")
    );
    assert!(!nested.exists());

    // Scratch keeps accepting any extension.
    let note = f.scratch.join("notes.txt");
    let scratch_write = run(
        &f,
        "Write",
        json!({ "path": note.to_string_lossy(), "content": "x" }),
    )
    .await;
    assert!(scratch_write.ok, "{:?}", scratch_write.content);
    assert_eq!(scratch_write.content["root"], "scratch");
}

#[tokio::test]
async fn rejects_dotdot_and_symlink_escapes_from_the_visualization_root() {
    let f = fixture();
    let escape = format!("{}/../../outside.html", f.visualization.to_string_lossy());
    let dotdot = run(&f, "Write", json!({ "path": escape, "content": "x" })).await;
    assert!(!dotdot.ok);
    assert!(!f.data_dir.join("outside.html").exists());

    #[cfg(unix)]
    {
        let outside = f.data_dir.join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&f.visualization).unwrap();
        std::os::unix::fs::symlink(&outside, f.visualization.join("link")).unwrap();
        let through_link = f.visualization.join("link").join("x.html");
        let linked = run(
            &f,
            "Write",
            json!({ "path": through_link.to_string_lossy(), "content": "x" }),
        )
        .await;
        assert!(!linked.ok);
        assert!(!outside.join("x.html").exists());
    }
}

#[test]
fn visualization_writes_skip_prompts_except_remote_and_contract_modes() {
    let f = fixture();
    let roots = local_contained_roots(&f.data_dir, "s1", false);
    let args = json!({ "path": f.visualization.join("a.html").to_string_lossy() });
    assert!(contained_write_auto_allowed(
        false, "agent", &roots, "Write", &args
    ));
    assert!(contained_write_auto_allowed(
        false, "agent", &roots, "Edit", &args
    ));
    assert!(!contained_write_auto_allowed(
        false, "plan", &roots, "Write", &args
    ));
    assert!(!contained_write_auto_allowed(
        false, "goal", &roots, "Write", &args
    ));
    assert!(!contained_write_auto_allowed(
        true, "agent", &roots, "Write", &args
    ));
    assert!(!contained_write_auto_allowed(
        false, "agent", &roots, "Bash", &args
    ));
    let workspace_args = json!({ "path": "notes.txt" });
    assert!(!contained_write_auto_allowed(
        false,
        "agent",
        &roots,
        "Write",
        &workspace_args
    ));
}

#[test]
fn remote_sessions_get_no_visualization_root() {
    let f = fixture();
    let remote = local_contained_roots(&f.data_dir, "s1", true);
    let path = f.visualization.join("a.html");
    assert!(remote.lexical_root(&path.to_string_lossy()).is_none());
    let local = local_contained_roots(&f.data_dir, "s1", false);
    assert_eq!(
        local
            .lexical_root(&path.to_string_lossy())
            .map(|root| root.kind),
        Some(ToolRoot::Visualization)
    );
}

#[test]
fn visualization_paths_do_not_require_external_path_permission() {
    let f = fixture();
    let roots = local_contained_roots(&f.data_dir, "s1", false);
    let workspace = f.workspace.to_string_lossy().to_string();
    let inside = json!({ "path": f.visualization.join("a.html").to_string_lossy() });
    assert!(!requires_external_path_permission(
        Some(&workspace),
        &roots,
        "Read",
        &inside
    ));
    assert!(!requires_external_path_permission(
        Some(&workspace),
        &roots,
        "Write",
        &inside
    ));
    let other_session = visualizations::session_dir(&f.data_dir, "s2").unwrap();
    let foreign = json!({ "path": other_session.join("a.html").to_string_lossy() });
    assert!(requires_external_path_permission(
        Some(&workspace),
        &roots,
        "Write",
        &foreign
    ));
}

#[test]
fn visualization_writes_are_not_review_snapshotted() {
    let f = fixture();
    let roots = local_contained_roots(&f.data_dir, "s1", false);
    let pending = review::prepare_change(
        &f.data_dir,
        "s1",
        "call-1",
        Some(&f.workspace),
        &roots,
        "Write",
        &json!({ "path": f.visualization.join("a.html").to_string_lossy() }),
    )
    .unwrap();
    assert!(pending.is_none());
}

#[test]
fn deleting_session_side_data_removes_its_visualizations() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::open(data.path()).unwrap();
    let dir = visualizations::session_dir(&state.data_dir, "gone").unwrap();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("a.html"), "<p></p>").unwrap();
    let kept = visualizations::session_dir(&state.data_dir, "kept").unwrap();
    fs::create_dir_all(&kept).unwrap();
    drop_session_side_data(&state, "gone");
    assert!(!dir.exists());
    assert!(kept.exists());
}

#[test]
fn moving_a_fragment_out_of_contained_roots_needs_a_prompt() {
    let f = fixture();
    let roots = local_contained_roots(&f.data_dir, "s1", false);
    let path = f.visualization.join("a.html");
    let ops_for = |dest: &str| format!("[{}#AAAA]\nMV {dest}\n", path.display());
    let to_workspace = json!({ "path": path.to_string_lossy(), "ops": ops_for("src/main.rs") });
    assert!(!contained_write_auto_allowed(
        false,
        "agent",
        &roots,
        "Edit",
        &to_workspace
    ));
    let inside = f.visualization.join("b.html");
    let within = json!({
        "path": path.to_string_lossy(),
        "ops": ops_for(&inside.to_string_lossy()),
    });
    assert!(contained_write_auto_allowed(
        false, "agent", &roots, "Edit", &within
    ));
}

#[tokio::test]
async fn visualization_rules_apply_when_the_workspace_contains_the_data_dir() {
    let f = fixture();
    let roots = local_contained_roots(&f.data_dir, "s1", false);
    let nested = f.visualization.join("nested").join("x.html");
    let resolved = workspace::resolve_tool_path(&f.data_dir, &roots, &nested.to_string_lossy());
    assert!(
        resolved.is_err() || resolved.as_ref().unwrap().1 == ToolRoot::Visualization,
        "visualization paths must not resolve as workspace: {resolved:?}"
    );
    let result = tools::execute_tool_with_path_access(
        Some(&f.data_dir),
        Some(&f.scratch),
        "Write",
        &json!({ "path": f.visualization.join("notes.txt").to_string_lossy(), "content": "x" }),
        options(Some(&f.visualization)),
    )
    .await;
    assert!(!result.ok, "non-html write must be rejected: {result:?}");
    assert!(!f.visualization.join("notes.txt").exists());
}

#[tokio::test]
async fn visualization_redirection_can_only_execute_as_explicitly_approved_external_access() {
    for mode in ["ask", "accept-edits"] {
        let f = fixture();
        let (state, id) = rpc_session(&f, false, mode).await;
        let root = visualizations::session_dir(&f.data_dir, &id).unwrap();
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::write(f.workspace.join("index.html"), "before approval").unwrap();
        crate::session_worktrees::test_support::link_dir(&f.workspace, &root);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let pending = tokio::spawn(handle_request(
            state.clone(),
            "tools.execute",
            json!({"sessionId": id, "toolCallId": "external-write", "toolName": "Write", "mode": "agent",
                "args": {"path": root.join("index.html"), "content": "approved external write"}}),
            tx.clone(),
        ));
        let permission: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(permission["method"], "permissions.request");
        assert_eq!(
            fs::read_to_string(f.workspace.join("index.html")).unwrap(),
            "before approval"
        );
        handle_request(
            state,
            "permissions.resolve",
            json!({"requestId": permission["params"]["requestId"], "decision": "allow-once"}),
            tx,
        )
        .await
        .unwrap();
        let written = pending.await.unwrap().unwrap();
        assert_eq!(written["ok"], true, "{written}");
        assert_eq!(written["content"]["root"], "external");
        assert_eq!(
            fs::read_to_string(f.workspace.join("index.html")).unwrap(),
            "approved external write"
        );
    }
}

#[tokio::test]
async fn visualization_alias_spelling_preserves_root_identity_even_inside_the_workspace() {
    let f = fixture();
    let alias = f.workspace.join("profile-alias");
    crate::session_worktrees::test_support::link_dir(&f.data_dir, &alias);
    let root = visualizations::session_dir(&alias, "s1").unwrap();
    let roots = local_contained_roots(&alias, "s1", false);
    let path = f.visualization.join("chart.html");
    let written = tools::execute_tool_with_path_access(
        Some(&f.data_dir),
        Some(&f.scratch),
        "Write",
        &json!({"path": path, "content": "<p>chart</p>"}),
        options(Some(&root)),
    )
    .await;
    assert!(written.ok, "{written:?}");
    assert_eq!(written.content["root"], "visualization");
    fs::rename(&f.visualization, f.data_dir.join("old-root")).unwrap();
    crate::session_worktrees::test_support::link_dir(&f.workspace, &f.visualization);
    for path in [root.join("chart.html"), f.visualization.join("chart.html")] {
        let args = json!({"path": path});
        assert!(!contained_write_auto_allowed(
            false, "agent", &roots, "Write", &args
        ));
        assert!(requires_external_path_permission(
            Some(&f.data_dir.to_string_lossy()),
            &roots,
            "Read",
            &args
        ));
        assert!(
            workspace::resolve_tool_path(&f.data_dir, &roots, &path.to_string_lossy()).is_err()
        );
    }
}
