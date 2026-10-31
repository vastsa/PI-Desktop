use super::*;
use crate::session_worktrees::registry::WorktreeStatus;
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use std::fs;

struct Fixture {
    _dir: tempfile::TempDir,
    repo: std::path::PathBuf,
    row: WorktreeRow,
}

fn fixture(lines: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let repo = init_repo(&dir.path().join("repo"));
    fs::write(repo.join("f.txt"), lines).unwrap();
    git_cmd(&repo, &["add", "f.txt"]);
    git_cmd(&repo, &["commit", "-q", "-m", "f"]);
    let worktree = dir.path().join("wt");
    git_cmd(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "pi-desktop/s1",
            worktree.to_str().unwrap(),
            "main",
        ],
    );
    let row = WorktreeRow {
        id: "w".into(),
        session_id: Some("s".into()),
        delegation_id: None,
        path: worktree.to_string_lossy().into_owned(),
        common_dir: repo.join(".git").to_string_lossy().into_owned(),
        prefix: String::new(),
        branch: "pi-desktop/s1".into(),
        owner_branch: "main".into(),
        status: WorktreeStatus::Active,
        setup_status: None,
        setup_log: None,
        port_base: None,
        created_at: 0,
        updated_at: 0,
    };
    Fixture {
        _dir: dir,
        repo,
        row,
    }
}

fn wt(f: &Fixture) -> &Path {
    Path::new(&f.row.path)
}

async fn merge_now(f: &Fixture) -> Result<MergeOutcome, WorktreeError> {
    let git = GitRunner::default();
    let token = preview(&git, &f.row).await.unwrap().preview_token;
    merge(&git, &f.row, &f.repo, "Session title", &token).await
}

/// AC5 + AC5a: the preview lists committed and uncommitted work, and the
/// merge lands every session commit on the project branch.
#[tokio::test]
async fn preview_then_merge_lands_session_commits_and_uncommitted_work() {
    let f = fixture("a\nb\n");
    fs::write(wt(&f).join("f.txt"), "A\nb\n").unwrap();
    git_cmd(wt(&f), &["commit", "-q", "-am", "edit f"]);
    fs::write(wt(&f).join("new.txt"), "n").unwrap();

    let git = GitRunner::default();
    let preview = preview(&git, &f.row).await.unwrap();
    assert_eq!(preview.commits.len(), 1);
    assert_eq!(preview.commits[0].subject, "edit f");
    let summary: Vec<_> = preview
        .files
        .iter()
        .map(|file| (file.status.as_str(), file.path.as_str(), file.uncommitted))
        .collect();
    assert_eq!(summary, vec![("M", "f.txt", false), ("?", "new.txt", true)]);

    let outcome = merge(
        &git,
        &f.row,
        &f.repo,
        "Session title",
        &preview.preview_token,
    )
    .await
    .unwrap();
    assert_eq!(
        outcome,
        MergeOutcome::Merged {
            commits: 1,
            files: 2
        }
    );
    assert_eq!(fs::read_to_string(f.repo.join("f.txt")).unwrap(), "A\nb\n");
    assert_eq!(fs::read_to_string(f.repo.join("new.txt")).unwrap(), "n");
    let log = git_cmd(&f.repo, &["log", "--format=%s", "-3"]);
    assert!(
        log.contains("edit f") && log.contains("pi: Session title"),
        "{log}"
    );
    assert_eq!(git_cmd(&f.repo, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn a_change_after_the_preview_stops_the_merge() {
    let f = fixture("a\n");
    fs::write(wt(&f).join("f.txt"), "A\n").unwrap();
    let git = GitRunner::default();
    let token = preview(&git, &f.row).await.unwrap().preview_token;
    fs::write(wt(&f).join("later.txt"), "x").unwrap();
    let error = merge(&git, &f.row, &f.repo, "t", &token).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CHANGED_SINCE_PREVIEW");
    assert_eq!(fs::read_to_string(f.repo.join("f.txt")).unwrap(), "a\n");
}

/// AC6: the conflict stays in the worktree; the project never has
/// MERGE_HEAD; a second merge after resolution succeeds, including a
/// resolution that was edited but not staged.
#[tokio::test]
async fn conflicts_stay_in_the_worktree_and_resolve_on_retry() {
    let f = fixture("a\nb\n");
    fs::write(wt(&f).join("f.txt"), "SESSION\nb\n").unwrap();
    git_cmd(wt(&f), &["commit", "-q", "-am", "session"]);
    fs::write(f.repo.join("f.txt"), "PROJECT\nb\n").unwrap();
    git_cmd(&f.repo, &["commit", "-q", "-am", "project"]);

    let error = merge_now(&f).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CONFLICT");
    assert_eq!(error.files, vec!["f.txt"]);
    assert!(!f.repo.join(".git/MERGE_HEAD").exists());
    assert_eq!(git_cmd(&f.repo, &["status", "--porcelain"]), "");
    assert_eq!(
        fs::read_to_string(f.repo.join("f.txt")).unwrap(),
        "PROJECT\nb\n"
    );

    // Still unresolved: a second click reports the same conflict.
    assert_eq!(merge_now(&f).await.unwrap_err().code, "WORKTREE_CONFLICT");

    // The agent edits the file without staging it.
    fs::write(wt(&f).join("f.txt"), "BOTH\nb\n").unwrap();
    assert!(matches!(
        merge_now(&f).await.unwrap(),
        MergeOutcome::Merged { .. }
    ));
    assert_eq!(
        fs::read_to_string(f.repo.join("f.txt")).unwrap(),
        "BOTH\nb\n"
    );
}

/// AC7: overlapping uncommitted or untracked project files refuse the
/// merge and leave both checkouts unchanged; unrelated dirty files stay.
#[tokio::test]
async fn dirty_project_files_refuse_the_merge_without_changes() {
    let f = fixture("a\n");
    fs::write(wt(&f).join("f.txt"), "A\n").unwrap();
    fs::write(wt(&f).join("n.txt"), "session").unwrap();
    git_cmd(wt(&f), &["add", "-A"]);
    git_cmd(wt(&f), &["commit", "-q", "-m", "s"]);

    fs::write(f.repo.join("f.txt"), "local edit\n").unwrap();
    let error = merge_now(&f).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_PROJECT_DIRTY");
    assert_eq!(
        fs::read_to_string(f.repo.join("f.txt")).unwrap(),
        "local edit\n"
    );
    git_cmd(&f.repo, &["checkout", "--", "f.txt"]);

    fs::write(f.repo.join("n.txt"), "mine").unwrap();
    assert_eq!(
        merge_now(&f).await.unwrap_err().code,
        "WORKTREE_PROJECT_DIRTY"
    );
    assert_eq!(fs::read_to_string(f.repo.join("n.txt")).unwrap(), "mine");
    fs::remove_file(f.repo.join("n.txt")).unwrap();

    fs::write(f.repo.join("README.md"), "unrelated\n").unwrap();
    assert!(matches!(
        merge_now(&f).await.unwrap(),
        MergeOutcome::Merged { .. }
    ));
    assert_eq!(
        fs::read_to_string(f.repo.join("README.md")).unwrap(),
        "unrelated\n"
    );
    assert_eq!(fs::read_to_string(f.repo.join("f.txt")).unwrap(), "A\n");
}

#[tokio::test]
async fn switching_the_project_branch_blocks_the_merge() {
    let f = fixture("a\n");
    fs::write(wt(&f).join("f.txt"), "A\n").unwrap();
    git_cmd(&f.repo, &["checkout", "-q", "-b", "other"]);
    assert_eq!(
        merge_now(&f).await.unwrap_err().code,
        "WORKTREE_OWNER_BRANCH_CHANGED"
    );
    assert_eq!(fs::read_to_string(f.repo.join("f.txt")).unwrap(), "a\n");
    // The refusal did not commit the session's work either.
    assert_eq!(git_cmd(wt(&f), &["status", "--porcelain"]), " M f.txt\n");
}

#[tokio::test]
async fn an_unchanged_session_has_nothing_to_merge() {
    let f = fixture("a\n");
    assert_eq!(merge_now(&f).await.unwrap(), MergeOutcome::NothingToMerge);
}

/// A re-edit that leaves `git status` unchanged still invalidates the
/// preview, so the merge never lands content the user did not review.
#[tokio::test]
async fn re_editing_a_modified_file_after_the_preview_stops_the_merge() {
    let f = fixture("a\n");
    fs::write(wt(&f).join("f.txt"), "A\n").unwrap();
    fs::write(wt(&f).join("new.txt"), "one").unwrap();
    let git = GitRunner::default();
    let token = preview(&git, &f.row).await.unwrap().preview_token;
    fs::write(wt(&f).join("f.txt"), "unreviewed\n").unwrap();
    let error = merge(&git, &f.row, &f.repo, "t", &token).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CHANGED_SINCE_PREVIEW");

    let token = preview(&git, &f.row).await.unwrap().preview_token;
    fs::write(wt(&f).join("new.txt"), "two").unwrap();
    let error = merge(&git, &f.row, &f.repo, "t", &token).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CHANGED_SINCE_PREVIEW");
    assert_eq!(fs::read_to_string(f.repo.join("f.txt")).unwrap(), "a\n");
}

/// Binary and modify/delete conflicts leave no markers; a retry must not
/// silently take the session's side, only an explicit `git add`/`git rm`.
#[tokio::test]
async fn markerless_conflicts_stay_unresolved_until_staged() {
    let f = fixture("a\n");
    fs::write(f.repo.join("bin.dat"), b"\0base").unwrap();
    git_cmd(&f.repo, &["add", "bin.dat"]);
    git_cmd(&f.repo, &["commit", "-q", "-m", "bin"]);
    git_cmd(wt(&f), &["merge", "-q", "main"]);

    fs::write(wt(&f).join("bin.dat"), b"\0session").unwrap();
    fs::remove_file(wt(&f).join("f.txt")).unwrap();
    git_cmd(wt(&f), &["commit", "-q", "-am", "session"]);
    fs::write(f.repo.join("bin.dat"), b"\0project").unwrap();
    fs::write(f.repo.join("f.txt"), "project\n").unwrap();
    git_cmd(&f.repo, &["commit", "-q", "-am", "project"]);

    let error = merge_now(&f).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CONFLICT");
    let error = merge_now(&f).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CONFLICT");
    assert_eq!(error.files, vec!["bin.dat", "f.txt"]);
    assert_eq!(
        fs::read(f.repo.join("bin.dat")).unwrap(),
        b"\0project".to_vec()
    );

    git_cmd(wt(&f), &["add", "bin.dat"]);
    git_cmd(wt(&f), &["rm", "-q", "f.txt"]);
    assert!(matches!(
        merge_now(&f).await.unwrap(),
        MergeOutcome::Merged { .. }
    ));
    assert!(!f.repo.join("f.txt").exists());
}

/// Conflicts git resolves without markers by attribute (`merge=binary`,
/// for example lock files) and custom marker sizes are not mistaken for
/// resolved edits.
#[tokio::test]
async fn attribute_driven_conflicts_need_an_explicit_add() {
    for attributes in ["f.txt merge=binary\n", "f.txt conflict-marker-size=10\n"] {
        let f = fixture("a\n");
        fs::write(f.repo.join(".gitattributes"), attributes).unwrap();
        git_cmd(&f.repo, &["add", ".gitattributes"]);
        git_cmd(&f.repo, &["commit", "-q", "-m", "attributes"]);
        git_cmd(wt(&f), &["merge", "-q", "main"]);
        fs::write(wt(&f).join("f.txt"), "SESSION\n").unwrap();
        git_cmd(wt(&f), &["commit", "-q", "-am", "session"]);
        fs::write(f.repo.join("f.txt"), "PROJECT\n").unwrap();
        git_cmd(&f.repo, &["commit", "-q", "-am", "project"]);

        assert_eq!(
            merge_now(&f).await.unwrap_err().code,
            "WORKTREE_CONFLICT",
            "{attributes}"
        );
        // A retry must not take the session's side silently.
        assert_eq!(
            merge_now(&f).await.unwrap_err().code,
            "WORKTREE_CONFLICT",
            "{attributes}"
        );
        assert!(!conflicts_resolved(&GitRunner::default(), wt(&f))
            .await
            .unwrap());
        assert_eq!(
            fs::read_to_string(f.repo.join("f.txt")).unwrap(),
            "PROJECT\n"
        );

        fs::write(wt(&f).join("f.txt"), "BOTH\n").unwrap();
        git_cmd(wt(&f), &["add", "f.txt"]);
        assert!(matches!(
            merge_now(&f).await.unwrap(),
            MergeOutcome::Merged { .. }
        ));
        assert_eq!(fs::read_to_string(f.repo.join("f.txt")).unwrap(), "BOTH\n");
    }
}

/// A preview never follows an untracked link or opens a special file, so
/// a link to `/dev/zero` or a FIFO cannot hang the host.
#[cfg(unix)]
#[tokio::test]
async fn previews_do_not_read_through_links_or_special_files() {
    let f = fixture("a\n");
    std::os::unix::fs::symlink("/dev/zero", wt(&f).join("zero")).unwrap();
    let status = std::process::Command::new("mkfifo")
        .arg(wt(&f).join("pipe"))
        .status()
        .unwrap();
    assert!(status.success());
    let git = GitRunner::default();
    let first = tokio::time::timeout(std::time::Duration::from_secs(20), preview(&git, &f.row))
        .await
        .expect("preview must not block")
        .unwrap();
    // The link target is part of the token: retargeting it invalidates it.
    fs::remove_file(wt(&f).join("zero")).unwrap();
    std::os::unix::fs::symlink("/dev/null", wt(&f).join("zero")).unwrap();
    let second = preview(&git, &f.row).await.unwrap();
    assert_ne!(first.preview_token, second.preview_token);
}

/// A tag named like the owner branch does not redirect the merge.
#[tokio::test]
async fn a_tag_named_like_the_owner_branch_is_ignored() {
    let f = fixture("a\n");
    git_cmd(&f.repo, &["tag", "main"]);
    fs::write(f.repo.join("later.txt"), "later\n").unwrap();
    git_cmd(&f.repo, &["add", "later.txt"]);
    git_cmd(&f.repo, &["commit", "-q", "-m", "later"]);
    fs::write(wt(&f).join("f.txt"), "A\n").unwrap();

    let git = GitRunner::default();
    let preview = preview(&git, &f.row).await.unwrap();
    assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
    assert!(matches!(
        merge_now(&f).await.unwrap(),
        MergeOutcome::Merged { .. }
    ));
    assert_eq!(
        fs::read_to_string(f.repo.join("later.txt")).unwrap(),
        "later\n"
    );
    assert_eq!(fs::read_to_string(f.repo.join("f.txt")).unwrap(), "A\n");
}

#[test]
fn porcelain_entries_keep_rename_targets_and_mark_untracked() {
    let parsed = parse_porcelain("R  new.txt\0old.txt\0?? x.txt\0 M y.txt\0");
    assert_eq!(
        parsed,
        vec![
            ("R".to_string(), "new.txt".to_string()),
            ("?".to_string(), "x.txt".to_string()),
            ("M".to_string(), "y.txt".to_string()),
        ]
    );
}

/// The merge brings the project branch in too, so a project commit made
/// after the preview invalidates the token instead of landing unseen.
#[tokio::test]
async fn a_project_commit_after_the_preview_stops_the_merge() {
    let f = fixture("a\n");
    fs::write(wt(&f).join("s.txt"), "s").unwrap();
    let git = GitRunner::default();
    let token = preview(&git, &f.row).await.unwrap().preview_token;
    fs::write(f.repo.join("p.txt"), "p").unwrap();
    git_cmd(&f.repo, &["add", "p.txt"]);
    git_cmd(&f.repo, &["commit", "-q", "-m", "project moved on"]);

    let error = merge(&git, &f.row, &f.repo, "t", &token).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CHANGED_SINCE_PREVIEW");
    assert!(!f.repo.join("s.txt").exists());
    assert!(!wt(&f).join("p.txt").exists());

    let fresh = preview(&git, &f.row).await.unwrap().preview_token;
    assert!(matches!(
        merge(&git, &f.row, &f.repo, "t", &fresh).await.unwrap(),
        MergeOutcome::Merged { .. }
    ));
}

/// A large untracked file rewritten in place with the same length and its
/// old modification time still invalidates the preview: the whole file is
/// hashed, not only its size and time.
#[tokio::test]
async fn a_large_untracked_rewrite_that_keeps_size_and_time_stops_the_merge() {
    let f = fixture("a\n");
    let big = wt(&f).join("big.bin");
    let size = 17 * 1024 * 1024;
    fs::write(&big, vec![b'a'; size]).unwrap();
    let modified = fs::metadata(&big).unwrap().modified().unwrap();
    let git = GitRunner::default();
    let token = preview(&git, &f.row).await.unwrap().preview_token;

    let mut rewritten = vec![b'a'; size];
    rewritten[size - 1] = b'b';
    fs::write(&big, rewritten).unwrap();
    fs::File::options()
        .write(true)
        .open(&big)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(fs::metadata(&big).unwrap().modified().unwrap(), modified);

    let error = merge(&git, &f.row, &f.repo, "t", &token).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_CHANGED_SINCE_PREVIEW");
    assert!(!f.repo.join("big.bin").exists());
}

/// When the session worktree is on another branch (for example after the
/// agent ran `git checkout`), nothing is committed there and nothing merges.
#[tokio::test]
async fn a_worktree_on_another_branch_is_neither_committed_nor_merged() {
    let f = fixture("a\n");
    git_cmd(wt(&f), &["checkout", "-q", "-b", "side"]);
    fs::write(wt(&f).join("s.txt"), "s").unwrap();
    git_cmd(&f.repo, &["commit", "-q", "--allow-empty", "-m", "project"]);
    let git = GitRunner::default();
    let token = preview(&git, &f.row).await.unwrap().preview_token;

    let error = merge(&git, &f.row, &f.repo, "t", &token).await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_SESSION_BRANCH_CHANGED");
    let error = sync_from_owner(&git, &f.row, "t").await.unwrap_err();
    assert_eq!(error.code, "WORKTREE_SESSION_BRANCH_CHANGED");
    assert_eq!(
        git_cmd(wt(&f), &["status", "--porcelain"]).trim(),
        "?? s.txt"
    );
    assert_eq!(
        git_cmd(&f.repo, &["rev-parse", "side"]),
        git_cmd(&f.repo, &["rev-parse", "pi-desktop/s1"])
    );
    assert!(!f.repo.join("s.txt").exists());
}

/// The fast-forward is checked after the fact: if the project switched
/// branches in the instant before git read its `HEAD`, the wrong branch is
/// reported instead of a silent success.
#[tokio::test]
async fn a_landing_on_a_switched_target_is_reported() {
    let f = fixture("a\n");
    fs::write(wt(&f).join("f.txt"), "b\n").unwrap();
    git_cmd(wt(&f), &["commit", "-q", "-am", "s"]);
    let git = GitRunner::default();
    let landing = rev_parse(&git, wt(&f), &head_ref(&f.row.branch))
        .await
        .unwrap();

    // `other`, not `main`, received the session's commit.
    git_cmd(&f.repo, &["checkout", "-q", "-b", "other"]);
    git_cmd(&f.repo, &["merge", "-q", "--ff-only", &landing]);
    let error = verify_landed(&git, &f.repo, &f.row, &landing)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_OWNER_BRANCH_CHANGED");
    git_cmd(&f.repo, &["checkout", "-q", "main"]);
    let error = verify_landed(&git, &f.repo, &f.row, &landing)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKTREE_OWNER_BRANCH_CHANGED");

    git_cmd(&f.repo, &["merge", "-q", "--ff-only", &landing]);
    verify_landed(&git, &f.repo, &f.row, &landing)
        .await
        .unwrap();
    // A commit made on the project right after the merge still counts.
    git_cmd(&f.repo, &["commit", "-q", "--allow-empty", "-m", "after"]);
    verify_landed(&git, &f.repo, &f.row, &landing)
        .await
        .unwrap();
}
