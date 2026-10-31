use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::*;
use crate::session_worktrees::test_support::{git_cmd, init_repo, link_dir};

struct Env {
    _dir: tempfile::TempDir,
    state: SharedState,
    git: GitRunner,
    project: PathBuf,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "f"]);
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let state = Arc::new(Mutex::new(AppState::open(&data).unwrap()));
    Env {
        _dir: dir,
        state,
        git: GitRunner::default(),
        project,
    }
}

async fn new_session(env: &Env, project: &Path) -> String {
    let st = env.state.lock().await;
    sessions::create_session_with_options(
        &st.db,
        sessions::SessionCreateOptions {
            title: Some("Isolated".into()),
            mode: None,
            provider_id: None,
            model_id: None,
            project_path: Some(project.to_string_lossy().into_owned()),
            thinking_level: None,
            permission_mode: None,
            fast_mode: false,
        },
    )
    .unwrap()
    .id
}

async fn isolated(env: &Env) -> (String, CreatedWorktree, PathBuf) {
    isolated_in(env, &env.project.clone()).await
}

async fn isolated_in(env: &Env, project: &Path) -> (String, CreatedWorktree, PathBuf) {
    let session = new_session(env, project).await;
    let created =
        create_session_worktree(&env.state, &env.git, &session, &project.to_string_lossy())
            .await
            .unwrap();
    let root = tool_root(&env.state.lock().await.db, &session)
        .unwrap()
        .unwrap();
    (session, created, root)
}

async fn wait_for_setup(env: &Env, session: &str) -> WorktreeRow {
    for _ in 0..600 {
        let row = registry::for_owner(&env.state.lock().await.db, session, None)
            .unwrap()
            .unwrap();
        if row.setup_status != Some(SetupStatus::Running) {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("setup did not finish");
}

fn canonical(path: &Path) -> PathBuf {
    crate::workspace::simple_canonicalize(path).unwrap()
}

/// AC2: the root lies outside the project, nothing is created inside the
/// project, and the project stays clean.
#[tokio::test]
async fn an_isolated_session_works_outside_an_untouched_project() {
    let env = env();
    let before: Vec<_> = fs::read_dir(&env.project)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    let (session, created, root) = isolated(&env).await;

    assert!(!canonical(&root).starts_with(canonical(&env.project)));
    assert!(root.join("f.txt").is_file());
    assert_eq!(created.worktree.status, WorktreeStatus::Active);
    assert!(created.worktree.branch.starts_with("pi-desktop/"));
    let after: Vec<_> = fs::read_dir(&env.project)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(before, after);
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
    assert!(git_cmd(&env.project, &["branch", "--list"]).contains(&created.worktree.branch));

    let summary = sessions::session_summary(&env.state.lock().await.db, &session)
        .unwrap()
        .unwrap();
    assert_eq!(summary.worktree.unwrap().branch, created.worktree.branch);
}

/// AC1: two isolated sessions edit the same file without seeing each other.
#[tokio::test]
async fn two_isolated_sessions_edit_the_same_file_independently() {
    let env = env();
    let (_a, _, root_a) = isolated(&env).await;
    let (_b, _, root_b) = isolated(&env).await;
    assert_ne!(root_a, root_b);
    fs::write(root_a.join("f.txt"), "from a\n").unwrap();
    fs::write(root_b.join("f.txt"), "from b\n").unwrap();
    assert_eq!(
        fs::read_to_string(root_a.join("f.txt")).unwrap(),
        "from a\n"
    );
    assert_eq!(
        fs::read_to_string(root_b.join("f.txt")).unwrap(),
        "from b\n"
    );
    assert_eq!(
        fs::read_to_string(env.project.join("f.txt")).unwrap(),
        "base\n"
    );
}

/// AC12: sessions without a worktree resolve exactly as before.
#[tokio::test]
async fn a_regular_session_has_no_worktree_root_or_environment() {
    let env = env();
    let session = new_session(&env, &env.project).await;
    let st = env.state.lock().await;
    assert_eq!(tool_root(&st.db, &session).unwrap(), None);
    assert!(tool_env(&st.db, &session).is_empty());
    assert!(sessions::session_summary(&st.db, &session)
        .unwrap()
        .unwrap()
        .worktree
        .is_none());
}

/// AC4: uncommitted project changes are reported and not carried over.
#[tokio::test]
async fn uncommitted_project_changes_are_not_carried_over() {
    let env = env();
    fs::write(env.project.join("f.txt"), "local edit\n").unwrap();
    fs::write(env.project.join("draft.txt"), "draft").unwrap();
    let (_session, created, root) = isolated(&env).await;
    assert!(created.project_had_uncommitted_changes);
    assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "base\n");
    assert!(!root.join("draft.txt").exists());
}

/// AC19: distinct port blocks; the variables reach only isolated sessions.
#[tokio::test]
async fn each_worktree_gets_its_own_port_block_and_environment() {
    let env = env();
    let (a, _, root_a) = isolated(&env).await;
    let (b, _, _) = isolated(&env).await;
    let st = env.state.lock().await;
    let env_a: HashMap<_, _> = tool_env(&st.db, &a).into_iter().collect();
    let env_b: HashMap<_, _> = tool_env(&st.db, &b).into_iter().collect();
    let port_a: i64 = env_a["PI_PORT"].parse().unwrap();
    let port_b: i64 = env_b["PI_PORT"].parse().unwrap();
    assert!((port_a - port_b).abs() >= registry::PORT_BLOCK);
    assert_eq!(PathBuf::from(&env_a["PI_WORKTREE_ROOT"]), root_a);
    assert_eq!(
        canonical(Path::new(&env_a["PI_PROJECT_ROOT"])),
        canonical(&env.project)
    );
}

/// The setup command runs in the default command shell, which is PowerShell
/// on Windows and bash elsewhere, so each command is written per dialect.
fn default_shell_is_powershell() -> bool {
    crate::tools::shell::dialect_for_id(crate::tools::shell::default_shell_id())
        == Some("powershell")
}

/// AC3 + AC15: the setup command runs in the new worktree with the project
/// root available; a failure is recorded and the session stays usable.
#[tokio::test]
async fn the_setup_command_runs_once_and_its_failure_does_not_block() {
    let env = env();
    fs::write(env.project.join(".gitignore"), ".env\n").unwrap();
    git_cmd(&env.project, &["add", ".gitignore"]);
    git_cmd(&env.project, &["commit", "-q", "-m", "ignore"]);
    fs::write(env.project.join(".env"), "SECRET=1\n").unwrap();
    {
        let st = env.state.lock().await;
        let session = new_session_blocking(&st.db, &env.project);
        drop(session);
        let command = if default_shell_is_powershell() {
            "Copy-Item \"$env:PI_PROJECT_ROOT/.env\" .env; \
             Set-Content -NoNewline -Path port.txt -Value $env:PI_PORT; \
             Write-Output prepared"
        } else {
            "cp \"$PI_PROJECT_ROOT/.env\" .env && printf %s \"$PI_PORT\" > port.txt && echo prepared"
        };
        assert!(set_setup_command(&st.db, &env.project.to_string_lossy(), Some(command)).unwrap());
    }
    let (session, created, root) = isolated(&env).await;
    assert_eq!(created.worktree.setup_status, Some(SetupStatus::Running));
    let row = wait_for_setup(&env, &session).await;
    assert_eq!(
        row.setup_status,
        Some(SetupStatus::Ok),
        "{:?}",
        row.setup_log
    );
    assert!(row.setup_log.unwrap().contains("prepared"));
    assert_eq!(fs::read_to_string(root.join(".env")).unwrap(), "SECRET=1\n");
    assert_eq!(
        fs::read_to_string(root.join("port.txt")).unwrap(),
        row.port_base.unwrap().to_string()
    );

    {
        let st = env.state.lock().await;
        let failing = if default_shell_is_powershell() {
            "[Console]::Error.WriteLine('broken'); exit 3"
        } else {
            "echo broken >&2; exit 3"
        };
        set_setup_command(&st.db, &env.project.to_string_lossy(), Some(failing)).unwrap();
    }
    let (failing, _, _) = isolated(&env).await;
    let row = wait_for_setup(&env, &failing).await;
    assert_eq!(row.setup_status, Some(SetupStatus::Failed));
    assert!(row.setup_log.unwrap().contains("broken"));
    assert!(tool_root(&env.state.lock().await.db, &failing)
        .unwrap()
        .is_some());

    {
        let st = env.state.lock().await;
        set_setup_command(&st.db, &env.project.to_string_lossy(), None).unwrap();
    }
    let (_quiet, created, _) = isolated(&env).await;
    assert_eq!(created.worktree.setup_status, Some(SetupStatus::None));
}

fn new_session_blocking(db: &Database, project: &Path) -> String {
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: None,
            mode: None,
            provider_id: None,
            model_id: None,
            project_path: Some(project.to_string_lossy().into_owned()),
            thinking_level: None,
            permission_mode: None,
            fast_mode: false,
        },
    )
    .unwrap()
    .id
}

/// AC20: a project that is a repository subdirectory keeps its scope, and
/// `.worktreeinclude` at the repository top level is honored.
#[tokio::test]
async fn a_subdirectory_project_keeps_its_scope_in_the_worktree() {
    let env = env();
    let app = env.project.join("packages/app");
    fs::create_dir_all(&app).unwrap();
    fs::write(app.join("a.txt"), "app\n").unwrap();
    fs::write(env.project.join(".gitignore"), ".env\n").unwrap();
    fs::write(env.project.join(".worktreeinclude"), ".env\n").unwrap();
    git_cmd(&env.project, &["add", "-A"]);
    git_cmd(&env.project, &["commit", "-q", "-m", "app"]);
    fs::write(env.project.join(".env"), "TOP=1\n").unwrap();

    let (_session, created, root) = isolated_in(&env, &app).await;
    assert!(root.ends_with("packages/app"));
    assert!(root.join("a.txt").is_file());
    assert_eq!(created.included.copied, vec![".env"]);
    assert!(root
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".env")
        .is_file());
}

/// AC8: deleting removes the worktree and branch; pending work is reported
/// first. AC17: a session deleted by another path leaves no orphan behind.
#[tokio::test]
async fn deletion_removes_worktrees_by_any_path() {
    let env = env();
    let (session, created, root) = isolated(&env).await;
    fs::write(root.join("f.txt"), "edit\n").unwrap();
    git_cmd(&root, &["commit", "-q", "-am", "work"]);
    fs::write(root.join("extra.txt"), "x").unwrap();
    let pending = pending_work(&env.state, &env.git, &session).await.unwrap();
    assert_eq!(pending.unmerged_commits, 1);
    assert!(pending.uncommitted_changes);

    remove_session_worktrees(&env.state, &env.git, &session)
        .await
        .unwrap();
    assert!(!root.exists());
    assert!(!git_cmd(&env.project, &["branch", "--list"]).contains(&created.worktree.branch));
    assert_eq!(
        fs::read_to_string(env.project.join("f.txt")).unwrap(),
        "base\n"
    );

    let (other, other_created, other_root) = isolated(&env).await;
    sessions::delete_session(&env.state.lock().await.db, &other).unwrap();
    assert_eq!(cleanup_orphans(&env.state, &env.git).await, 1);
    assert!(!other_root.exists());
    assert!(!git_cmd(&env.project, &["branch", "--list"]).contains(&other_created.worktree.branch));
    assert!(registry::orphans(&env.state.lock().await.db)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn startup_reconcile_drops_partial_rows_and_marks_vanished_worktrees() {
    let env = env();
    let (session, _, root) = isolated(&env).await;
    let partial_session = new_session(&env, &env.project).await;
    let partial_path = env._dir.path().join("partial");
    {
        let st = env.state.lock().await;
        registry::insert(
            &st.db,
            &NewWorktree {
                session_id: &partial_session,
                delegation_id: None,
                path: &partial_path.to_string_lossy(),
                common_dir: &env.project.join(".git").to_string_lossy(),
                prefix: "",
                branch: "pi-desktop/partial",
                owner_branch: "main",
                port_base: None,
            },
        )
        .unwrap();
    }
    git_cmd(
        &env.project,
        &["worktree", "unlock", root.to_str().unwrap()],
    );
    fs::remove_dir_all(&root).unwrap();

    reconcile(env.state.clone(), env.git.clone()).await;

    let st = env.state.lock().await;
    assert!(registry::for_owner(&st.db, &partial_session, None)
        .unwrap()
        .is_none());
    let row = registry::for_owner(&st.db, &session, None)
        .unwrap()
        .unwrap();
    assert_eq!(row.status, WorktreeStatus::Missing);
    assert_eq!(
        tool_root(&st.db, &session).unwrap_err().code,
        "WORKTREE_MISSING"
    );
}

#[tokio::test]
async fn projects_that_cannot_host_a_worktree_leave_nothing_behind() {
    let env = env();
    let plain = env._dir.path().join("plain");
    fs::create_dir_all(&plain).unwrap();
    let session = new_session(&env, &plain).await;
    let error = create_session_worktree(&env.state, &env.git, &session, &plain.to_string_lossy())
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_NOT_GIT");
    assert!(registry::for_session(&env.state.lock().await.db, &session)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_running_session_is_neither_merged_nor_deleted() {
    let env = env();
    let (session, _, _) = isolated(&env).await;
    {
        let st = env.state.lock().await;
        st.db
            .conn()
            .execute(
                "INSERT INTO turns (id, session_id, status, started_at) VALUES ('t1', ?1, 'running', 1)",
                params![session],
            )
            .unwrap();
    }
    assert_eq!(
        remove_session_worktrees(&env.state, &env.git, &session)
            .await
            .unwrap_err()
            .code,
        "WORKTREE_BUSY"
    );
    assert_eq!(
        merge_session(&env.state, &env.git, &session, "token")
            .await
            .unwrap_err()
            .code,
        "WORKTREE_BUSY"
    );
}

/// A pre-existing branch with the session's name is refused, and the failed
/// creation never deletes it.
#[tokio::test]
async fn an_existing_branch_blocks_creation_without_being_deleted() {
    let env = env();
    let session = new_session(&env, &env.project).await;
    let branch = format!("{BRANCH_NAMESPACE}/{}", short_id(&session));
    git_cmd(&env.project, &["branch", &branch]);

    let error = create_session_worktree(
        &env.state,
        &env.git,
        &session,
        &env.project.to_string_lossy(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "WORKTREE_PATH_EXISTS");
    assert!(git_cmd(&env.project, &["branch", "--list"]).contains(&branch));
    assert!(registry::for_session(&env.state.lock().await.db, &session)
        .unwrap()
        .is_empty());
}

/// When the owner branch is gone, unmerged session commits are still
/// reported for the delete confirmation instead of counting as zero.
#[tokio::test]
async fn pending_work_counts_commits_after_the_owner_branch_is_renamed() {
    let env = env();
    let (session, _created, root) = isolated(&env).await;
    fs::write(root.join("f.txt"), "edit\n").unwrap();
    git_cmd(&root, &["commit", "-q", "-am", "work"]);
    git_cmd(&env.project, &["branch", "-m", "main", "renamed"]);

    let pending = pending_work(&env.state, &env.git, &session).await.unwrap();
    assert_eq!(pending.unmerged_commits, 1);
}

/// The conflict badge clears once the agent resolved every conflict or
/// abandoned the merge, not only after the next successful merge.
#[tokio::test]
async fn the_conflict_badge_clears_when_the_conflict_is_resolved() {
    let env = env();
    fs::write(env.project.join("g.txt"), "base\n").unwrap();
    git_cmd(&env.project, &["add", "g.txt"]);
    git_cmd(&env.project, &["commit", "-q", "-m", "g"]);
    let (session, _created, root) = isolated(&env).await;
    for file in ["f.txt", "g.txt"] {
        fs::write(root.join(file), "session\n").unwrap();
        fs::write(env.project.join(file), "project\n").unwrap();
    }
    git_cmd(&env.project, &["commit", "-q", "-am", "project"]);
    let status = |env: &Env| {
        let st = env.state.try_lock().unwrap();
        registry::for_owner(&st.db, &session, None)
            .unwrap()
            .unwrap()
            .status
    };
    let merge_now = || async {
        let token = preview_session(&env.state, &env.git, &session)
            .await
            .unwrap()
            .preview_token;
        merge_session(&env.state, &env.git, &session, &token).await
    };
    assert_eq!(merge_now().await.unwrap_err().code, "WORKTREE_CONFLICT");
    assert_eq!(status(&env), WorktreeStatus::Conflict);

    // Half resolved: still a conflict.
    fs::write(root.join("f.txt"), "both\n").unwrap();
    refresh_conflict_status(&env.state, &env.git, &session).await;
    assert_eq!(status(&env), WorktreeStatus::Conflict);

    fs::write(root.join("g.txt"), "both\n").unwrap();
    refresh_conflict_status(&env.state, &env.git, &session).await;
    assert_eq!(status(&env), WorktreeStatus::Active);
    // The pending resolution still concludes on the next merge.
    assert!(matches!(
        merge_now().await.unwrap(),
        MergeOutcome::Merged { .. }
    ));
    assert_eq!(
        fs::read_to_string(env.project.join("g.txt")).unwrap(),
        "both\n"
    );

    // Abandoning a merge clears the badge too.
    fs::write(root.join("f.txt"), "again\n").unwrap();
    fs::write(env.project.join("f.txt"), "other\n").unwrap();
    git_cmd(&env.project, &["commit", "-q", "-am", "other"]);
    assert_eq!(merge_now().await.unwrap_err().code, "WORKTREE_CONFLICT");
    git_cmd(&root, &["merge", "--abort"]);
    refresh_conflict_status(&env.state, &env.git, &session).await;
    assert_eq!(status(&env), WorktreeStatus::Active);
}

/// The user's scenario: session 1 merges, session 2 merges after resolving a
/// conflict with it. "Sync from project" brings that resolution into session
/// 1, so its later edits on the same line merge without a repeat conflict.
#[tokio::test]
async fn syncing_brings_another_sessions_resolution_into_the_session() {
    let env = env();
    let (one, _c1, root1) = isolated(&env).await;
    let (two, _c2, root2) = isolated(&env).await;
    let merge_now = |session: String| {
        let env = &env;
        async move {
            let token = preview_session(&env.state, &env.git, &session)
                .await
                .unwrap()
                .preview_token;
            merge_session(&env.state, &env.git, &session, &token).await
        }
    };
    fs::write(root1.join("f.txt"), "A\n").unwrap();
    merge_now(one.clone()).await.unwrap();
    fs::write(root2.join("f.txt"), "B\n").unwrap();
    assert_eq!(
        merge_now(two.clone()).await.unwrap_err().code,
        "WORKTREE_CONFLICT"
    );
    fs::write(root2.join("f.txt"), "AB\n").unwrap();
    merge_now(two.clone()).await.unwrap();

    // Session 1 still has its old code and knows it is behind.
    assert_eq!(fs::read_to_string(root1.join("f.txt")).unwrap(), "A\n");
    assert!(behind_session(&env.state, &env.git, &one).await.unwrap() > 0);
    let synced = sync_session(&env.state, &env.git, &one).await.unwrap();
    assert!(matches!(synced, SyncOutcome::Synced { .. }));
    assert_eq!(fs::read_to_string(root1.join("f.txt")).unwrap(), "AB\n");
    assert_eq!(behind_session(&env.state, &env.git, &one).await.unwrap(), 0);
    assert_eq!(
        sync_session(&env.state, &env.git, &one).await.unwrap(),
        SyncOutcome::UpToDate
    );
    // Syncing never touches the project.
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");

    fs::write(root1.join("f.txt"), "AB2\n").unwrap();
    assert!(matches!(
        merge_now(one.clone()).await.unwrap(),
        MergeOutcome::Merged { .. }
    ));
    assert_eq!(
        fs::read_to_string(env.project.join("f.txt")).unwrap(),
        "AB2\n"
    );
}

/// A sync conflict stays in the session worktree, marks the session, and
/// leaves the project untouched; resolving it clears the mark.
#[tokio::test]
async fn a_sync_conflict_stays_in_the_session() {
    let env = env();
    let (session, _created, root) = isolated(&env).await;
    fs::write(env.project.join("f.txt"), "project\n").unwrap();
    git_cmd(&env.project, &["commit", "-q", "-am", "project"]);
    fs::write(root.join("f.txt"), "session\n").unwrap();

    let error = sync_session(&env.state, &env.git, &session)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_CONFLICT");
    assert_eq!(error.files, vec!["f.txt"]);
    let status = |env: &Env| {
        let st = env.state.try_lock().unwrap();
        registry::for_owner(&st.db, &session, None)
            .unwrap()
            .unwrap()
            .status
    };
    assert_eq!(status(&env), WorktreeStatus::Conflict);
    assert_eq!(
        fs::read_to_string(env.project.join("f.txt")).unwrap(),
        "project\n"
    );
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");

    fs::write(root.join("f.txt"), "both\n").unwrap();
    // Sync again concludes the resolution; nothing else is behind.
    assert_eq!(
        sync_session(&env.state, &env.git, &session).await.unwrap(),
        SyncOutcome::UpToDate
    );
    assert_eq!(status(&env), WorktreeStatus::Active);
    assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "both\n");
}

/// The sidebar marker: after one session merges, the other is behind and the
/// merged one is not; a vanished worktree is left out.
#[tokio::test]
async fn behind_all_counts_what_each_session_lacks() {
    let env = env();
    let (one, _c1, root1) = isolated(&env).await;
    let (two, _c2, _root2) = isolated(&env).await;
    let (gone, _c3, root3) = isolated(&env).await;
    let counts = behind_all(&env.state, &env.git).await.unwrap().counts;
    assert_eq!(counts.get(&one), Some(&0));
    assert_eq!(counts.get(&two), Some(&0));

    fs::write(root1.join("f.txt"), "A\n").unwrap();
    let token = preview_session(&env.state, &env.git, &one)
        .await
        .unwrap()
        .preview_token;
    merge_session(&env.state, &env.git, &one, &token)
        .await
        .unwrap();
    crate::session_worktrees::remove::clear_contents(&root3).unwrap();
    fs::remove_dir_all(&root3).unwrap();

    let counts = behind_all(&env.state, &env.git).await.unwrap().counts;
    assert_eq!(counts.get(&one), Some(&0));
    assert_eq!(counts.get(&two), Some(&1));
    assert!(!counts.contains_key(&gone));
}

/// A merge that concludes the resolution and then fails (dirty project)
/// must not leave a stale conflict badge; a conflict resolved outside the
/// app is picked up by the background behind check.
#[tokio::test]
async fn failed_merges_and_outside_resolutions_do_not_leave_a_stale_badge() {
    let env = env();
    let (session, _created, root) = isolated(&env).await;
    let status = |env: &Env| {
        let st = env.state.try_lock().unwrap();
        registry::for_owner(&st.db, &session, None)
            .unwrap()
            .unwrap()
            .status
    };
    let merge_now = || async {
        let token = preview_session(&env.state, &env.git, &session)
            .await
            .unwrap()
            .preview_token;
        merge_session(&env.state, &env.git, &session, &token).await
    };
    let make_conflict = |line: &str| {
        fs::write(root.join("f.txt"), format!("session {line}\n")).unwrap();
        fs::write(env.project.join("f.txt"), format!("project {line}\n")).unwrap();
        git_cmd(&env.project, &["commit", "-q", "-am", line]);
    };

    make_conflict("1");
    assert_eq!(merge_now().await.unwrap_err().code, "WORKTREE_CONFLICT");
    fs::write(root.join("f.txt"), "both 1\n").unwrap();
    fs::write(env.project.join("f.txt"), "local edit\n").unwrap();
    assert_eq!(
        merge_now().await.unwrap_err().code,
        "WORKTREE_PROJECT_DIRTY"
    );
    assert_eq!(status(&env), WorktreeStatus::Active);
    git_cmd(&env.project, &["checkout", "--", "f.txt"]);
    assert!(matches!(
        merge_now().await.unwrap(),
        MergeOutcome::Merged { .. }
    ));

    make_conflict("2");
    assert_eq!(merge_now().await.unwrap_err().code, "WORKTREE_CONFLICT");
    // Resolved by hand in an editor, without any tool call of the session.
    fs::write(root.join("f.txt"), "both 2\n").unwrap();
    let behind = behind_all(&env.state, &env.git).await.unwrap();
    assert!(behind.statuses_changed);
    assert_eq!(status(&env), WorktreeStatus::Active);
}

/// A tool of the session still in flight blocks a merge and a sync, so no
/// write can interleave with the checkpoint commit or the merge, and neither
/// changes anything. Once the tool ends, the same merge goes through.
#[tokio::test]
async fn a_running_tool_blocks_merge_and_sync_without_changing_anything() {
    let env = env();
    let (session, _created, root) = isolated(&env).await;
    fs::write(root.join("f.txt"), "session\n").unwrap();
    git_cmd(
        &env.project,
        &["commit", "-q", "--allow-empty", "-m", "ahead"],
    );
    let token = preview_session(&env.state, &env.git, &session)
        .await
        .unwrap()
        .preview_token;
    let budget = env.state.lock().await.tool_budget.clone();
    let running = budget.acquire(&session, "Bash").await.unwrap();

    let error = merge_session(&env.state, &env.git, &session, &token)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_BUSY");
    let error = sync_session(&env.state, &env.git, &session)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_BUSY");
    assert_eq!(git_cmd(&root, &["status", "--porcelain"]).trim(), "M f.txt");
    assert_eq!(git_cmd(&root, &["rev-list", "--count", "HEAD"]).trim(), "2");
    assert_eq!(
        fs::read_to_string(env.project.join("f.txt")).unwrap(),
        "base\n"
    );

    drop(running);
    assert!(matches!(
        merge_session(&env.state, &env.git, &session, &token)
            .await
            .unwrap(),
        MergeOutcome::Merged { .. }
    ));
}

/// A registered worktree folder replaced by a link (a junction on Windows)
/// is never used as a tool root, merged, or emptied; deleting the session
/// removes the link itself and the branch, never the link's target.
#[tokio::test]
async fn a_worktree_folder_replaced_by_a_link_is_never_followed() {
    let env = env();
    let (session, created, root) = isolated(&env).await;
    let outside = env._dir.path().join("user-folder");
    fs::create_dir_all(outside.join("nested")).unwrap();
    fs::write(outside.join("KEEP_ME.txt"), "keep").unwrap();
    fs::write(outside.join("nested/KEEP_TOO.txt"), "keep").unwrap();
    fs::rename(&root, env._dir.path().join("moved-away")).unwrap();
    link_dir(&outside, &root);

    let error = tool_root(&env.state.lock().await.db, &session).unwrap_err();
    assert_eq!(error.code, "WORKTREE_MISSING");
    let error = preview_session(&env.state, &env.git, &session)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_MISSING");
    let error = sync_session(&env.state, &env.git, &session)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_MISSING");
    let pending = pending_work(&env.state, &env.git, &session).await.unwrap();
    assert!(!pending.uncommitted_changes);

    remove_session_worktrees(&env.state, &env.git, &session)
        .await
        .unwrap();
    assert!(fs::symlink_metadata(&root).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("KEEP_ME.txt")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(outside.join("nested/KEEP_TOO.txt")).unwrap(),
        "keep"
    );
    assert!(!git_cmd(&env.project, &["branch", "--list"]).contains(&created.worktree.branch));
}
