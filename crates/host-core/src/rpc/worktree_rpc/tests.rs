//! Representative user path through the real RPC entry point (ADR 0329):
//! probe -> create isolated session -> agent writes and runs Bash in the
//! worktree -> preview -> merge -> delete.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::super::{handle_request, requires_external_path_permission, resolve_tool_workspace};
use crate::session_worktrees::lifecycle;
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::state::AppState;

async fn call(state: &Arc<Mutex<AppState>>, method: &str, params: Value) -> Result<Value, Value> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0)
        .await
        .map_err(|error| {
            json!({
                "code": error.code,
                "errorCode": error.data.as_ref().and_then(|data| data.get("errorCode")).cloned(),
            })
        })
}

fn tool_options(
    bash: Option<crate::tools::BashExecutionOptions>,
) -> crate::tools::ToolExecutionOptions<'static> {
    crate::tools::ToolExecutionOptions {
        timeout_ms: None,
        bash_options: bash,
        allow_external_paths: false,
        hashline: None,
        visualization_root: None,
    }
}

fn canonical(path: &Path) -> PathBuf {
    crate::workspace::simple_canonicalize(path).unwrap()
}

#[tokio::test]
async fn isolated_session_user_path_from_create_to_delete() {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "f"]);
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let mut app = AppState::open(&data).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let project_text = project.to_string_lossy().into_owned();

    let probe = call(
        &state,
        "worktree.probe",
        json!({ "projectPath": project_text }),
    )
    .await
    .unwrap();
    assert_eq!(probe["available"], true);
    assert_eq!(probe["uncommittedChanges"], false);

    let created = call(
        &state,
        "session.create",
        json!({ "projectPath": project_text, "isolated": true, "title": "Feature" }),
    )
    .await
    .unwrap();
    let session_id = created["session"]["id"].as_str().unwrap().to_string();
    let branch = created["session"]["worktree"]["branch"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(created["worktree"]["worktree"]["status"], "active");
    let listed = call(&state, "session.list", json!({})).await.unwrap();
    let row = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == session_id.as_str())
        .unwrap();
    assert_eq!(row["worktree"]["branch"], branch.as_str());

    // Every tool of the session resolves to the worktree, not the project.
    let (root, env) = {
        let st = state.lock().await;
        (
            PathBuf::from(resolve_tool_workspace(&st, &session_id).unwrap().unwrap()),
            lifecycle::tool_env(&st.db, &session_id),
        )
    };
    assert!(!canonical(&root).starts_with(canonical(&project)));

    let written = crate::tools::execute_tool_with_path_access(
        Some(&root),
        None,
        "Write",
        &json!({ "path": "f.txt", "content": "isolated\n" }),
        tool_options(None),
    )
    .await;
    assert!(written.ok, "{:?}", written.content);
    assert_eq!(fs::read_to_string(project.join("f.txt")).unwrap(), "base\n");

    // The main checkout is outside the root, so it needs the existing
    // external-path permission; isolation does not weaken containment.
    assert!(requires_external_path_permission(
        Some(&root.to_string_lossy()),
        &crate::workspace::ContainedRoots::new(),
        "Write",
        &json!({ "path": project.join("f.txt").to_string_lossy() }),
    ));

    let env_map: HashMap<_, _> = env.iter().cloned().collect();
    // Bash runs in the default command shell: PowerShell on Windows.
    let shell_id = crate::tools::shell::default_shell_id();
    let probe = if crate::tools::shell::dialect_for_id(shell_id) == Some("powershell") {
        "(Get-Location).Path; Write-Output $env:PI_PORT"
    } else {
        "pwd; printf %s \"$PI_PORT\""
    };
    let bash = crate::tools::execute_tool_with_path_access(
        Some(&root),
        None,
        "Bash",
        &json!({ "command": probe }),
        tool_options(Some(crate::tools::BashExecutionOptions {
            session_id: session_id.clone(),
            tool_call_id: "t1".into(),
            command_shell_id: shell_id.into(),
            timeout_ms: None,
            cancellation: None,
            output_tx: None,
            extra_env: env,
            run_in_background: false,
            app_state: None,
        })),
    )
    .await;
    assert!(bash.ok, "{:?}", bash.content);
    let stdout = bash.content["stdout"].as_str().unwrap();
    assert!(stdout.contains(&env_map["PI_PORT"]), "{stdout}");
    assert_eq!(
        canonical(Path::new(stdout.lines().next().unwrap().trim())),
        canonical(&root)
    );

    let preview = call(
        &state,
        "worktree.preview",
        json!({ "sessionId": session_id }),
    )
    .await
    .unwrap();
    let files = preview["preview"]["files"].as_array().unwrap();
    assert!(files.iter().any(|file| file["path"] == "f.txt"));
    let token = preview["preview"]["previewToken"]
        .as_str()
        .unwrap()
        .to_string();

    let stale = call(
        &state,
        "worktree.merge",
        json!({ "sessionId": session_id, "previewToken": "stale" }),
    )
    .await
    .unwrap_err();
    assert_eq!(stale["code"], 1025);
    assert_eq!(stale["errorCode"], "WORKTREE_CHANGED_SINCE_PREVIEW");

    let merged = call(
        &state,
        "worktree.merge",
        json!({ "sessionId": session_id, "previewToken": token }),
    )
    .await
    .unwrap();
    assert_eq!(merged["outcome"]["result"], "merged");
    assert_eq!(
        fs::read_to_string(project.join("f.txt")).unwrap(),
        "isolated\n"
    );
    assert!(git_cmd(&project, &["log", "--format=%s", "-1"]).contains("pi: Feature"));

    let moved = call(
        &state,
        "session.moveProject",
        json!({ "sessionId": session_id, "projectPath": dir.path().to_string_lossy() }),
    )
    .await
    .unwrap_err();
    assert_eq!(moved["errorCode"], "WORKTREE_MOVE_UNSUPPORTED");

    let pending = call(
        &state,
        "worktree.pendingWork",
        json!({ "sessionId": session_id }),
    )
    .await
    .unwrap();
    assert_eq!(pending["pending"]["unmergedCommits"], 0);
    assert_eq!(pending["pending"]["uncommittedChanges"], false);

    let deleted = call(&state, "session.delete", json!({ "id": session_id }))
        .await
        .unwrap();
    assert_eq!(deleted["ok"], true);
    assert!(!root.exists());
    assert!(!git_cmd(&project, &["branch", "--list"]).contains(&branch));
}

#[tokio::test]
async fn an_isolated_session_is_not_created_for_a_project_without_git() {
    let dir = tempfile::tempdir().unwrap();
    let plain = dir.path().join("plain");
    fs::create_dir_all(&plain).unwrap();
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let mut app = AppState::open(&data).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));

    let probe = call(&state, "worktree.probe", json!({ "projectPath": plain }))
        .await
        .unwrap();
    assert_eq!(probe["available"], false);
    assert_eq!(probe["errorCode"], "WORKTREE_NOT_GIT");

    let error = call(
        &state,
        "session.create",
        json!({ "projectPath": plain, "isolated": true }),
    )
    .await
    .unwrap_err();
    assert_eq!(error["errorCode"], "WORKTREE_NOT_GIT");
    let listed = call(&state, "session.list", json!({})).await.unwrap();
    assert!(listed["sessions"].as_array().unwrap().is_empty());

    // Without `isolated`, the same project creates an ordinary session.
    let ordinary = call(&state, "session.create", json!({ "projectPath": plain }))
        .await
        .unwrap();
    assert!(ordinary["session"].get("worktree").is_none());
}

/// Through `tools.execute`: an agent Write that resolves the last conflict
/// clears the session's conflict badge in `session.list`.
#[tokio::test]
async fn resolving_a_conflict_through_a_tool_call_clears_the_badge() {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "f"]);
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let mut app = AppState::open(&data).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let project_text = project.to_string_lossy().into_owned();
    call(
        &state,
        "settings.set",
        json!({ "defaultPermissionMode": "auto" }),
    )
    .await
    .unwrap();
    let created = call(
        &state,
        "session.create",
        json!({ "projectPath": project_text, "isolated": true, "mode": "agent" }),
    )
    .await
    .unwrap();
    let session_id = created["session"]["id"].as_str().unwrap().to_string();
    let root = {
        let st = state.lock().await;
        PathBuf::from(resolve_tool_workspace(&st, &session_id).unwrap().unwrap())
    };
    fs::write(root.join("f.txt"), "session\n").unwrap();
    fs::write(project.join("f.txt"), "project\n").unwrap();
    git_cmd(&project, &["commit", "-q", "-am", "project"]);
    let preview = call(
        &state,
        "worktree.preview",
        json!({ "sessionId": session_id }),
    )
    .await
    .unwrap();
    let token = preview["preview"]["previewToken"].clone();
    let refused = call(
        &state,
        "worktree.merge",
        json!({ "sessionId": session_id, "previewToken": token }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused["errorCode"], "WORKTREE_CONFLICT");
    let badge = |listed: &Value| {
        listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == session_id.as_str())
            .unwrap()["worktree"]["status"]
            .clone()
    };
    assert_eq!(
        badge(&call(&state, "session.list", json!({})).await.unwrap()),
        "conflict"
    );

    let written = call(
        &state,
        "tools.execute",
        json!({
            "sessionId": session_id,
            "toolCallId": "resolve-1",
            "mode": "agent",
            "toolName": "Write",
            "args": { "path": "f.txt", "content": "both\n" },
        }),
    )
    .await
    .unwrap();
    assert_eq!(written["ok"], true, "{written}");
    assert_eq!(
        badge(&call(&state, "session.list", json!({})).await.unwrap()),
        "active"
    );
}

/// `worktree.behind` and `worktree.sync` through the RPC entry point.
#[tokio::test]
async fn sync_from_project_through_rpc() {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "f"]);
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let mut app = AppState::open(&data).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let created = call(
        &state,
        "session.create",
        json!({ "projectPath": project.to_string_lossy(), "isolated": true }),
    )
    .await
    .unwrap();
    let session_id = created["session"]["id"].as_str().unwrap().to_string();
    assert_eq!(behind(&state, &session_id).await, 0);
    fs::write(project.join("g.txt"), "new\n").unwrap();
    git_cmd(&project, &["add", "g.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "g"]);
    assert_eq!(behind(&state, &session_id).await, 1);

    let synced = call(&state, "worktree.sync", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert_eq!(
        synced["outcome"],
        json!({ "result": "synced", "commits": 1 })
    );
    let root = {
        let st = state.lock().await;
        PathBuf::from(resolve_tool_workspace(&st, &session_id).unwrap().unwrap())
    };
    assert_eq!(fs::read_to_string(root.join("g.txt")).unwrap(), "new\n");
    let again = call(&state, "worktree.sync", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert_eq!(again["outcome"], json!({ "result": "upToDate" }));
}

async fn behind(state: &Arc<Mutex<AppState>>, session_id: &str) -> Value {
    call(state, "worktree.behind", json!({ "sessionId": session_id }))
        .await
        .unwrap()["commits"]
        .clone()
}

/// A handshaken host on `data` with one isolated session of `project`;
/// returns the state, the session id, and its tool root.
async fn isolated_session_of(
    project: &Path,
    data: &Path,
) -> (Arc<Mutex<AppState>>, String, PathBuf) {
    fs::create_dir_all(data).unwrap();
    let mut app = AppState::open(data).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let created = call(
        &state,
        "session.create",
        json!({ "projectPath": project.to_string_lossy(), "isolated": true, "title": "Windows" }),
    )
    .await
    .unwrap();
    let session_id = created["session"]["id"].as_str().unwrap().to_string();
    let root = {
        let st = state.lock().await;
        PathBuf::from(resolve_tool_workspace(&st, &session_id).unwrap().unwrap())
    };
    (state, session_id, root)
}

fn session_branches(project: &Path) -> String {
    git_cmd(project, &["branch", "--list", "pi-desktop/*"])
}

/// E2E-WORKTREE-isolated-session-lifecycle, Windows check: a path beyond 260
/// characters is checked out into the worktree, written through the tools,
/// and removed with the session. Git for Windows needs `core.longpaths` for
/// such a project, which a project that already holds them has set.
#[tokio::test]
async fn a_path_beyond_260_characters_is_created_and_removed() {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    git_cmd(&project, &["config", "core.longpaths", "true"]);
    let deep: PathBuf = (0..12)
        .map(|index| format!("segment-{index:02}-abcdefghijklmnop"))
        .collect();
    fs::create_dir_all(project.join(&deep)).unwrap();
    fs::write(project.join(&deep).join("deep.txt"), "deep\n").unwrap();
    git_cmd(&project, &["add", "-A"]);
    git_cmd(&project, &["commit", "-q", "-m", "deep"]);

    let (state, session_id, root) = isolated_session_of(&project, &dir.path().join("data")).await;
    let checked_out = root.join(&deep).join("deep.txt");
    assert!(checked_out.to_string_lossy().len() > 260, "{checked_out:?}");
    assert_eq!(fs::read_to_string(&checked_out).unwrap(), "deep\n");
    let written = crate::tools::execute_tool_with_path_access(
        Some(&root),
        None,
        "Write",
        &json!({ "path": deep.join("new.txt").to_string_lossy(), "content": "new\n" }),
        tool_options(None),
    )
    .await;
    assert!(written.ok, "{:?}", written.content);
    assert_eq!(
        fs::read_to_string(root.join(&deep).join("new.txt")).unwrap(),
        "new\n"
    );

    call(&state, "session.delete", json!({ "id": session_id }))
        .await
        .unwrap();
    assert!(!root.exists());
    assert_eq!(session_branches(&project).trim(), "");
    assert_eq!(
        fs::read_to_string(project.join(&deep).join("deep.txt")).unwrap(),
        "deep\n"
    );
}

/// E2E-WORKTREE-isolated-session-lifecycle, Windows check: deleting while a
/// file in the worktree is held open without delete sharing fails visibly
/// (`WORKTREE_IO`), keeps the session and its worktree registration, and the
/// same delete succeeds once the file is released.
#[cfg(windows)]
#[tokio::test]
async fn deleting_with_a_locked_file_fails_visibly_and_can_be_retried() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    let (state, session_id, root) = isolated_session_of(&project, &dir.path().join("data")).await;
    fs::write(root.join("locked.txt"), "x").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(root.join("locked.txt"))
        .unwrap();

    let failed = call(&state, "session.delete", json!({ "id": session_id }))
        .await
        .unwrap_err();
    assert_eq!(failed["code"], 1025);
    assert_eq!(failed["errorCode"], "WORKTREE_IO");
    let listed = call(&state, "session.list", json!({})).await.unwrap();
    assert!(listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|session| session["id"] == session_id.as_str()));
    assert!(root.join("locked.txt").exists());
    assert_ne!(session_branches(&project).trim(), "");

    drop(lock);
    call(&state, "session.delete", json!({ "id": session_id }))
        .await
        .unwrap();
    assert!(!root.exists());
    assert_eq!(session_branches(&project).trim(), "");
}
