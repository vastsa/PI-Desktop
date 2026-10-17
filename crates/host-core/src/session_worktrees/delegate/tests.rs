use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::*;
use crate::session_worktrees::lifecycle::{self, create_session_worktree};
use crate::session_worktrees::test_support::{git_cmd, init_repo, link_dir};
use crate::state::AppState;

struct Env {
    _dir: tempfile::TempDir,
    state: SharedState,
    git: GitRunner,
    project: PathBuf,
    session: String,
    session_root: PathBuf,
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "one\ntwo\nthree\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "f"]);
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let state: SharedState = Arc::new(Mutex::new(AppState::open(&data).unwrap()));
    let git = GitRunner::default();
    let session = {
        let st = state.lock().await;
        crate::sessions::create_session_with_options(
            &st.db,
            crate::sessions::SessionCreateOptions {
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
    };
    create_session_worktree(&state, &git, &session, &project.to_string_lossy())
        .await
        .unwrap();
    let session_root = lifecycle::tool_root(&state.lock().await.db, &session)
        .unwrap()
        .unwrap();
    Env {
        _dir: dir,
        state,
        git,
        project,
        session,
        session_root,
    }
}

impl Env {
    async fn create(&self, delegation: &str) -> PathBuf {
        create_delegate_worktree(&self.state, &self.git, &self.session, delegation)
            .await
            .unwrap();
        tool_root(&self.state.lock().await.db, &self.session, Some(delegation))
            .unwrap()
            .unwrap()
    }

    async fn settle(&self, delegation: &str, merge: bool) -> DelegateSettlement {
        settle_delegate_worktree(&self.state, &self.git, &self.session, delegation, merge)
            .await
            .unwrap()
    }

    async fn row(&self, delegation: &str) -> Option<WorktreeRow> {
        registry::for_owner(&self.state.lock().await.db, &self.session, Some(delegation)).unwrap()
    }

    fn branches(&self) -> String {
        git_cmd(&self.project, &["branch", "--list"])
    }
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

/// R7: the subagent starts from the parent's current, uncommitted state, and
/// only calls that name its chain id resolve to its worktree.
#[tokio::test]
async fn a_writing_subagent_starts_from_the_parents_current_files() {
    let env = env().await;
    fs::write(env.session_root.join("parent.txt"), "draft").unwrap();
    let root = env.create("chain-a").await;

    assert_ne!(root, env.session_root);
    assert_eq!(read(&root.join("parent.txt")), "draft");
    assert_eq!(git_cmd(&env.session_root, &["status", "--porcelain"]), "");
    assert!(git_cmd(&env.session_root, &["log", "--format=%s", "-1"])
        .contains("checkpoint before subagent"));

    let st = env.state.lock().await;
    assert_eq!(tool_root(&st.db, &env.session, None).unwrap(), None);
    assert_eq!(
        tool_root(&st.db, &env.session, Some("unknown")).unwrap(),
        None
    );
    let own: std::collections::HashMap<_, _> = tool_env(&st.db, &env.session, Some("chain-a"))
        .into_iter()
        .collect();
    let parent: std::collections::HashMap<_, _> =
        tool_env(&st.db, &env.session, None).into_iter().collect();
    assert_ne!(own["PI_PORT"], parent["PI_PORT"]);
    assert_eq!(PathBuf::from(&own["PI_WORKTREE_ROOT"]), root);
}

/// AC10 + AC11: two writing subagents edit one file in parallel without
/// interfering, and both land on the session branch.
#[tokio::test]
async fn parallel_subagents_merge_back_into_the_session() {
    let env = env().await;
    let a = env.create("chain-a").await;
    let b = env.create("chain-b").await;
    fs::write(a.join("f.txt"), "ONE\ntwo\nthree\n").unwrap();
    fs::write(b.join("f.txt"), "one\ntwo\nTHREE\n").unwrap();
    assert_eq!(read(&a.join("f.txt")), "ONE\ntwo\nthree\n");
    assert_eq!(read(&b.join("f.txt")), "one\ntwo\nTHREE\n");

    assert_eq!(
        env.settle("chain-a", true).await,
        DelegateSettlement::Merged { commits: 1 }
    );
    assert_eq!(
        env.settle("chain-b", true).await,
        DelegateSettlement::Merged { commits: 1 }
    );
    assert_eq!(read(&env.session_root.join("f.txt")), "ONE\ntwo\nTHREE\n");
    assert!(!a.exists() && !b.exists());
    assert!(env.row("chain-a").await.is_none());
    assert!(!env.branches().contains("-chain"), "{}", env.branches());
    assert_eq!(read(&env.project.join("f.txt")), "one\ntwo\nthree\n");
}

/// AC11: a subagent without changes leaves no worktree or branch.
#[tokio::test]
async fn a_subagent_without_changes_leaves_nothing_behind() {
    let env = env().await;
    let root = env.create("chain-a").await;
    let before = env.branches();
    assert_eq!(
        env.settle("chain-a", true).await,
        DelegateSettlement::NoChanges
    );
    assert!(!root.exists());
    assert!(env.row("chain-a").await.is_none());
    assert!(env.branches().lines().count() < before.lines().count());
}

/// AC11: a conflict stays in the subagent worktree; after it is resolved
/// (as a resumed subagent would), the merge is retried and lands.
#[tokio::test]
async fn a_conflict_is_kept_for_the_subagent_and_merges_after_resolution() {
    let env = env().await;
    let a = env.create("chain-a").await;
    let b = env.create("chain-b").await;
    fs::write(a.join("f.txt"), "FROM A\ntwo\nthree\n").unwrap();
    fs::write(b.join("f.txt"), "FROM B\ntwo\nthree\n").unwrap();
    assert_eq!(
        env.settle("chain-a", true).await,
        DelegateSettlement::Merged { commits: 1 }
    );

    assert_eq!(
        env.settle("chain-b", true).await,
        DelegateSettlement::Conflict {
            files: vec!["f.txt".into()]
        }
    );
    assert_eq!(
        env.row("chain-b").await.unwrap().status,
        WorktreeStatus::Conflict
    );
    assert_eq!(
        read(&env.session_root.join("f.txt")),
        "FROM A\ntwo\nthree\n"
    );
    assert!(!env.session_root.join(".git").is_dir());
    assert_eq!(git_cmd(&env.session_root, &["status", "--porcelain"]), "");

    // A resume reuses the same worktree, conflict included.
    assert_eq!(env.create("chain-b").await, b);
    fs::write(b.join("f.txt"), "FROM A AND B\ntwo\nthree\n").unwrap();
    assert!(matches!(
        env.settle("chain-b", true).await,
        DelegateSettlement::Merged { .. }
    ));
    assert_eq!(
        read(&env.session_root.join("f.txt")),
        "FROM A AND B\ntwo\nthree\n"
    );
    assert!(!b.exists());
}

/// A failed or stopped run keeps its work for a resume and is not merged.
#[tokio::test]
async fn an_unfinished_run_keeps_its_changes_unmerged() {
    let env = env().await;
    let a = env.create("chain-a").await;
    fs::write(a.join("new.txt"), "partial").unwrap();
    assert_eq!(env.settle("chain-a", false).await, DelegateSettlement::Kept);
    assert!(a.join("new.txt").exists());
    assert!(!env.session_root.join("new.txt").exists());

    let b = env.create("chain-b").await;
    assert_eq!(
        env.settle("chain-b", false).await,
        DelegateSettlement::NoChanges
    );
    assert!(!b.exists());
    assert_eq!(
        env.settle("never-created", true).await,
        DelegateSettlement::None
    );
}

/// Anything git refuses keeps the subagent branch; nothing is forced.
#[tokio::test]
async fn an_unfinished_session_merge_blocks_without_forcing() {
    let env = env().await;
    let a = env.create("chain-a").await;
    fs::write(a.join("g.txt"), "subagent").unwrap();
    // The session worktree is in the middle of its own conflict resolution.
    git_cmd(&env.project, &["checkout", "-q", "-b", "side"]);
    fs::write(env.project.join("f.txt"), "SIDE\ntwo\nthree\n").unwrap();
    git_cmd(&env.project, &["commit", "-q", "-am", "side"]);
    git_cmd(&env.project, &["checkout", "-q", "main"]);
    fs::write(env.session_root.join("f.txt"), "SESSION\ntwo\nthree\n").unwrap();
    git_cmd(&env.session_root, &["commit", "-q", "-am", "session"]);
    let merged = std::process::Command::new("git")
        .arg("-C")
        .arg(&env.session_root)
        .args(["merge", "side"])
        .output()
        .unwrap();
    assert!(!merged.status.success());

    match env.settle("chain-a", true).await {
        DelegateSettlement::NotMerged { reason } => assert!(reason.contains("merge"), "{reason}"),
        other => panic!("expected NotMerged, got {other:?}"),
    }
    assert!(a.join("g.txt").exists());
    assert!(env.row("chain-a").await.is_some());
    assert!(!env.session_root.join("g.txt").exists());
}

/// A vanished subagent folder keeps its committed branch, and a resume
/// re-attaches it instead of deleting the work.
#[tokio::test]
async fn a_vanished_subagent_folder_keeps_and_reattaches_its_branch() {
    let env = env().await;
    let a = env.create("chain-a").await;
    fs::write(a.join("g.txt"), "committed").unwrap();
    git_cmd(&a, &["add", "g.txt"]);
    git_cmd(&a, &["commit", "-q", "-m", "subagent work"]);
    let branch = env.row("chain-a").await.unwrap().branch;
    crate::session_worktrees::remove::clear_contents(&a).unwrap();
    fs::remove_dir_all(&a).unwrap();

    assert_eq!(env.settle("chain-a", true).await, DelegateSettlement::Kept);
    assert!(env.branches().contains(&branch));

    let resumed = env.create("chain-a").await;
    assert_eq!(read(&resumed.join("g.txt")), "committed");
    assert!(matches!(
        env.settle("chain-a", true).await,
        DelegateSettlement::Merged { .. }
    ));
    assert_eq!(read(&env.session_root.join("g.txt")), "committed");
}

/// A long parent tool (for example a test run in Bash) never blocks the
/// subagent: after a bounded wait it merges holding only the write permit.
#[tokio::test]
async fn a_long_parent_tool_does_not_block_the_merge_back() {
    let env = env().await;
    let a = env.create("chain-a").await;
    fs::write(a.join("g.txt"), "subagent").unwrap();
    let budget = env.state.lock().await.tool_budget.clone();
    let _long_bash = budget.acquire(&env.session, "Bash").await.unwrap();

    assert!(matches!(
        env.settle("chain-a", true).await,
        DelegateSettlement::Merged { .. }
    ));
    assert_eq!(read(&env.session_root.join("g.txt")), "subagent");
}

/// Review follow-ups: a vanished subagent folder still counts toward the
/// delete warning, and a row left `missing` next to an existing folder is
/// usable again.
#[tokio::test]
async fn vanished_subagent_work_is_reported_and_a_restored_folder_is_usable() {
    let env = env().await;
    let a = env.create("chain-a").await;
    fs::write(a.join("g.txt"), "committed").unwrap();
    git_cmd(&a, &["add", "g.txt"]);
    git_cmd(&a, &["commit", "-q", "-m", "subagent work"]);
    crate::session_worktrees::remove::clear_contents(&a).unwrap();
    fs::remove_dir_all(&a).unwrap();
    let pending = lifecycle::pending_work(&env.state, &env.git, &env.session)
        .await
        .unwrap();
    assert!(pending.unmerged_commits >= 1, "{pending:?}");

    // A re-attach that failed after `worktree add` leaves the folder back
    // but the row `missing`.
    let b = env.create("chain-b").await;
    let row = env.row("chain-b").await.unwrap();
    registry::set_status(&env.state.lock().await.db, &row.id, WorktreeStatus::Missing).unwrap();
    assert_eq!(env.create("chain-b").await, b);
    assert_eq!(
        env.row("chain-b").await.unwrap().status,
        WorktreeStatus::Active
    );
}

/// With the owner branch gone, commits a subagent branch shares with the
/// session still count: the subagent branch is deleted with the session.
#[tokio::test]
async fn subagent_branches_do_not_hide_session_work_when_the_owner_is_gone() {
    let env = env().await;
    fs::write(env.session_root.join("f.txt"), "session\n").unwrap();
    git_cmd(&env.session_root, &["commit", "-q", "-am", "session work"]);
    env.create("chain-a").await;
    git_cmd(&env.project, &["branch", "-m", "main", "renamed"]);
    let pending = lifecycle::pending_work(&env.state, &env.git, &env.session)
        .await
        .unwrap();
    assert!(pending.unmerged_commits >= 1, "{pending:?}");
}

/// The parent switched its worktree to another branch: no checkpoint lands
/// on that branch, no subagent worktree is created, and a subagent whose own
/// worktree was switched is not committed or merged either.
#[tokio::test]
async fn a_switched_branch_never_receives_a_subagent_checkpoint() {
    let env = env().await;
    let a = env.create("chain-a").await;
    fs::write(a.join("sub.txt"), "sub").unwrap();
    git_cmd(&a, &["checkout", "-q", "-b", "sub-side"]);
    let kept = settle_delegate_worktree(&env.state, &env.git, &env.session, "chain-a", true)
        .await
        .unwrap_err();
    assert_eq!(kept.code, "WORKTREE_SESSION_BRANCH_CHANGED");
    assert_eq!(git_cmd(&a, &["status", "--porcelain"]).trim(), "?? sub.txt");

    git_cmd(&env.session_root, &["checkout", "-q", "-b", "side"]);
    fs::write(env.session_root.join("parent.txt"), "draft").unwrap();
    let error = create_delegate_worktree(&env.state, &env.git, &env.session, "chain-b")
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_SESSION_BRANCH_CHANGED");
    assert_eq!(
        git_cmd(&env.session_root, &["status", "--porcelain"]).trim(),
        "?? parent.txt"
    );
    assert!(env.row("chain-b").await.is_none());
}

/// A subagent folder replaced by a link (a junction on Windows) is not used;
/// a resume drops the link, never its target, and re-attaches the branch.
#[tokio::test]
async fn a_subagent_folder_replaced_by_a_link_is_reattached_without_its_target() {
    let env = env().await;
    let a = env.create("chain-a").await;
    fs::write(a.join("g.txt"), "committed").unwrap();
    git_cmd(&a, &["add", "g.txt"]);
    git_cmd(&a, &["commit", "-q", "-m", "subagent work"]);
    let outside = env._dir.path().join("user-folder");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("KEEP_ME.txt"), "keep").unwrap();
    crate::session_worktrees::remove::clear_contents(&a).unwrap();
    fs::remove_dir_all(&a).unwrap();
    link_dir(&outside, &a);

    assert_eq!(
        tool_root(&env.state.lock().await.db, &env.session, Some("chain-a"))
            .unwrap_err()
            .code,
        "WORKTREE_MISSING"
    );
    assert_eq!(env.create("chain-a").await, a);
    assert!(fs::symlink_metadata(&a).unwrap().is_dir());
    assert_eq!(read(&a.join("g.txt")), "committed");
    assert_eq!(read(&outside.join("KEEP_ME.txt")), "keep");
    assert!(!outside.join("g.txt").exists());
}
