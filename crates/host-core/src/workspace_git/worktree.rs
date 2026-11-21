//! One session's worktree and work branch inside a main checkout.
//!
//! Every repository-changing step holds the repository lock on the main
//! checkout's git directory, because worktrees share refs, the object store,
//! and worktree metadata. Names are re-validated here, and operands follow
//! `--` wherever git accepts it, so nothing a caller supplies can be read as
//! an option.

use std::path::{Path, PathBuf};
use std::{fs, io};

use super::layout::validate_branch;
use super::repository::{self, NetworkContext, PUSH_TIMEOUT};
use super::WorkspaceGitError;
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::registry::{WorktreeRow, WorktreeStatus};
use crate::session_worktrees::remove::{drop_admin_entry, remove_worktree};
use crate::session_worktrees::repo_lock;

/// Where a new worktree starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartPoint<'a> {
    /// `refs/remotes/origin/<branch>`: the session's base branch, as fetched.
    RemoteBranch(&'a str),
    /// `refs/heads/<branch>`: another session's work branch on this host,
    /// including commits it never pushed (a forked session).
    LocalBranch(&'a str),
}

impl StartPoint<'_> {
    fn branch(&self) -> &str {
        match self {
            StartPoint::RemoteBranch(branch) | StartPoint::LocalBranch(branch) => branch,
        }
    }

    fn reference(&self) -> String {
        match self {
            StartPoint::RemoteBranch(branch) => format!("refs/remotes/origin/{branch}"),
            StartPoint::LocalBranch(branch) => format!("refs/heads/{branch}"),
        }
    }

    fn missing(&self) -> WorkspaceGitError {
        match self {
            StartPoint::RemoteBranch(branch) => WorkspaceGitError::new(
                "WORKSPACE_GIT_BRANCH_NOT_FOUND",
                format!("branch `{branch}` does not exist on the remote"),
            ),
            StartPoint::LocalBranch(_) => WorkspaceGitError::new(
                "WORKSPACE_GIT_NOT_FOUND",
                "the session to start from has no work branch on this host",
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusCounts {
    /// Commits on the work branch that its remote branch lacks.
    pub ahead: u32,
    /// Commits on the remote work branch that the local one lacks.
    pub behind: u32,
    pub uncommitted_files: u32,
    /// Commits on the work branch that no remote branch contains.
    pub unpushed_commits: u32,
    /// Whether the work branch exists on the remote, as last seen.
    pub pushed_once: bool,
}

fn utf8(path: &Path) -> Result<&str, WorkspaceGitError> {
    path.to_str()
        .ok_or_else(|| WorkspaceGitError::invalid("path is not valid UTF-8"))
}

fn git_failed(
    step: &str,
) -> impl Fn(crate::session_worktrees::git::GitError) -> WorkspaceGitError + '_ {
    move |error| repository::from_git_error(step, error)
}

/// Create the worktree on a new `work_branch` and return the commit it starts
/// at. Leave existing paths and branches intact unless the caller has a
/// registry record proving ownership.
pub async fn create(
    git: &GitRunner,
    main_path: &Path,
    worktree_path: &Path,
    work_branch: &str,
    start: StartPoint<'_>,
) -> Result<String, WorkspaceGitError> {
    validate_branch(work_branch)?;
    validate_branch(start.branch())?;
    let path = utf8(worktree_path)?;
    let _lock = repo_lock::lock(&repository::common_dir(main_path)).await;

    let start_ref = start.reference();
    let resolved = git
        .output(
            main_path,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &format!("{start_ref}^{{commit}}"),
            ],
        )
        .await
        .map_err(git_failed("rev-parse"))?;
    if !resolved.success() {
        return Err(start.missing());
    }
    let base_commit = resolved.stdout.trim().to_string();

    match fs::symlink_metadata(worktree_path) {
        Ok(metadata) if metadata.is_dir() && fs::read_dir(worktree_path)?.next().is_none() => {}
        Ok(_) => {
            return Err(WorkspaceGitError::failed(
                "the worktree path already contains files",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Some(parent) = worktree_path.parent() {
        fs::create_dir_all(parent)?;
    }
    add(git, main_path, path, work_branch, Some(&base_commit)).await?;
    Ok(base_commit)
}

async fn add(
    git: &GitRunner,
    main_path: &Path,
    path: &str,
    work_branch: &str,
    base_commit: Option<&str>,
) -> Result<(), WorkspaceGitError> {
    // The upstream is set below to the work branch itself.
    let mut args = vec!["worktree", "add", "-q"];
    if let Some(base) = base_commit {
        args.extend(["--no-track", "-b", work_branch, "--", path, base]);
    } else {
        args.extend(["--", path, work_branch]);
    }
    git.run(main_path, &args)
        .await
        .map_err(git_failed("worktree add"))?;
    // Keep git from pruning the worktree while its directory is unreachable.
    git.run(
        main_path,
        &[
            "worktree",
            "lock",
            "--reason",
            "pi-desktop session worktree",
            "--",
            path,
        ],
    )
    .await
    .map_err(git_failed("worktree lock"))?;
    for (key, value) in [
        (format!("branch.{work_branch}.remote"), "origin".to_string()),
        (
            format!("branch.{work_branch}.merge"),
            format!("refs/heads/{work_branch}"),
        ),
    ] {
        git.run(main_path, &["config", "--local", "--", &key, &value])
            .await
            .map_err(git_failed("config"))?;
    }
    Ok(())
}

/// Restore a registered checkout without changing the local work branch.
pub async fn restore(
    git: &GitRunner,
    main_path: &Path,
    worktree_path: &Path,
    work_branch: &str,
) -> Result<(), WorkspaceGitError> {
    validate_branch(work_branch)?;
    let common = repository::common_dir(main_path);
    let _lock = repo_lock::lock(&common).await;
    match fs::symlink_metadata(worktree_path) {
        Ok(_) => {
            return Err(WorkspaceGitError::failed(
                "the registered worktree path is occupied",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Some(parent) = worktree_path.parent() {
        fs::create_dir_all(parent)?;
    }
    drop_admin_entry(&common, worktree_path)?;
    add(git, main_path, utf8(worktree_path)?, work_branch, None).await
}

/// Counts for one worktree. Read-only: it takes no repository lock.
pub async fn status(
    git: &GitRunner,
    worktree_path: &Path,
    work_branch: &str,
) -> Result<StatusCounts, WorkspaceGitError> {
    validate_branch(work_branch)?;
    let porcelain = git
        .run(
            worktree_path,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )
        .await
        .map_err(git_failed("status"))?;
    branch_status(
        git,
        worktree_path,
        work_branch,
        count_porcelain_entries(&porcelain),
    )
    .await
}

/// Read branch state from the main checkout when its linked directory is gone.
pub async fn branch_status(
    git: &GitRunner,
    worktree_path: &Path,
    work_branch: &str,
    uncommitted_files: u32,
) -> Result<StatusCounts, WorkspaceGitError> {
    validate_branch(work_branch)?;
    let local = format!("refs/heads/{work_branch}");
    let remote = format!("refs/remotes/origin/{work_branch}");
    let unpushed_commits = unpushed_commits(git, worktree_path, work_branch).await?;

    let pushed_once = git
        .output(
            worktree_path,
            &["show-ref", "--verify", "--quiet", "--", &remote],
        )
        .await
        .map_err(git_failed("show-ref"))?
        .success();
    let (ahead, behind) = if pushed_once {
        let counts = git
            .run(
                worktree_path,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("{local}...{remote}"),
                ],
            )
            .await
            .map_err(git_failed("rev-list"))?;
        let mut parts = counts.split_whitespace();
        (
            parse_count(parts.next().unwrap_or_default())?,
            parse_count(parts.next().unwrap_or_default())?,
        )
    } else {
        (0, 0)
    };
    Ok(StatusCounts {
        ahead,
        behind,
        uncommitted_files,
        unpushed_commits,
        pushed_once,
    })
}

/// Count branch-only commits even when the worktree directory has disappeared.
pub async fn unpushed_commits(
    git: &GitRunner,
    repository_path: &Path,
    work_branch: &str,
) -> Result<u32, WorkspaceGitError> {
    validate_branch(work_branch)?;
    let branch = format!("refs/heads/{work_branch}");
    let exists = git
        .output(
            repository_path,
            &["show-ref", "--verify", "--quiet", "--", &branch],
        )
        .await
        .map_err(git_failed("show-ref"))?;
    if exists.status == 1 {
        return Ok(0);
    }
    if !exists.success() {
        return Err(WorkspaceGitError::failed(
            "could not inspect the local work branch",
        ));
    }
    let unpushed = git
        .run(
            repository_path,
            &["rev-list", "--count", &branch, "--not", "--remotes=origin"],
        )
        .await
        .map_err(git_failed("rev-list"))?;
    parse_count(&unpushed)
}

pub async fn commits_ahead_of_base(
    git: &GitRunner,
    main_path: &Path,
    work_branch: &str,
    base_branch: &str,
    initial_commit: &str,
) -> Result<u32, WorkspaceGitError> {
    validate_branch(work_branch)?;
    validate_branch(base_branch)?;
    let base = format!("refs/remotes/origin/{base_branch}");
    let available = git
        .output(main_path, &["show-ref", "--verify", "--quiet", "--", &base])
        .await
        .map_err(git_failed("show-ref"))?;
    // A renamed or removed base can still report what the session added.
    let base = if available.success() {
        base.as_str()
    } else {
        initial_commit
    };
    let range = format!("{base}..refs/heads/{work_branch}");
    let count = git
        .run(
            main_path,
            &["rev-list", "--count", "--end-of-options", &range],
        )
        .await
        .map_err(git_failed("rev-list"))?;
    parse_count(&count)
}

fn parse_count(text: &str) -> Result<u32, WorkspaceGitError> {
    text.trim()
        .parse()
        .map_err(|_| WorkspaceGitError::failed("git returned an unreadable count"))
}

/// Entries of `git status --porcelain=v1 -z`. A rename or copy is one entry
/// followed by its original path as a second NUL-terminated field.
fn count_porcelain_entries(porcelain: &str) -> u32 {
    let mut count = 0;
    let mut fields = porcelain.split('\0').filter(|field| !field.is_empty());
    while let Some(entry) = fields.next() {
        count += 1;
        if matches!(entry.as_bytes().first(), Some(b'R' | b'C')) {
            fields.next();
        }
    }
    count
}

/// Remove the worktree directory, git's metadata for it, and the local work
/// branch. The remote branch is never touched. Missing parts are not an error.
pub async fn remove(
    git: &GitRunner,
    main_path: &Path,
    worktree_path: &Path,
    work_branch: &str,
) -> Result<(), WorkspaceGitError> {
    validate_branch(work_branch)?;
    let _lock = repo_lock::lock(&repository::common_dir(main_path)).await;
    remove_locked(git, main_path, worktree_path, work_branch).await
}

pub async fn remove_checked(
    git: &GitRunner,
    main_path: &Path,
    path: &Path,
    work_branch: &str,
    force: bool,
) -> Result<(bool, u32, u32), WorkspaceGitError> {
    let common_dir = repository::common_dir(main_path);
    let _lock = repo_lock::lock(&common_dir).await;
    let counts = if crate::session_worktrees::remove::is_real_dir(path) {
        let actual = git
            .run(
                path,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
            .await
            .map_err(git_failed("rev-parse"))?;
        if crate::workspace::simple_canonicalize(Path::new(actual.trim()))? != common_dir {
            return Err(WorkspaceGitError::failed(
                "the registered path belongs to another checkout",
            ));
        }
        status(git, path, work_branch)
            .await
            .map(|status| (status.uncommitted_files, status.unpushed_commits))
    } else {
        unpushed_commits(git, main_path, work_branch)
            .await
            .map(|commits| (0, commits))
    };
    let (files, commits) = match counts {
        Ok(counts) => counts,
        Err(_) if force => (0, 0),
        Err(error) => return Err(error),
    };
    if !force && (files > 0 || commits > 0) {
        return Ok((false, files, commits));
    }
    remove_locked(git, main_path, path, work_branch).await?;
    Ok((true, files, commits))
}

async fn remove_locked(
    git: &GitRunner,
    main_path: &Path,
    worktree_path: &Path,
    work_branch: &str,
) -> Result<(), WorkspaceGitError> {
    // The link-safe removal local isolated sessions use (ADR 0329): links
    // inside the worktree are removed as links, never followed.
    let row = WorktreeRow {
        id: String::new(),
        session_id: None,
        delegation_id: None,
        path: utf8(worktree_path)?.to_string(),
        common_dir: utf8(&repository::common_dir(main_path))?.to_string(),
        prefix: String::new(),
        branch: work_branch.to_string(),
        owner_branch: String::new(),
        status: WorktreeStatus::Active,
        setup_status: None,
        setup_log: None,
        port_base: None,
        created_at: 0,
        updated_at: 0,
    };
    remove_worktree(git, &row)
        .await
        .map_err(|error| WorkspaceGitError::failed(error.message))?;
    // The branch's upstream configuration goes with it.
    let section = format!("branch.{work_branch}");
    let _ = git
        .output(
            main_path,
            &["config", "--local", "--remove-section", "--", &section],
        )
        .await;
    Ok(())
}

/// Push the work branch, and only it, to `origin`; returns the remote head.
pub async fn push(
    ctx: &NetworkContext<'_>,
    worktree_path: &Path,
    work_branch: &str,
) -> Result<String, WorkspaceGitError> {
    validate_branch(work_branch)?;
    let common = ctx
        .git
        .run(
            worktree_path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await
        .map_err(git_failed("rev-parse"))?;
    let _lock = repo_lock::lock(&crate::workspace::simple_canonicalize(&PathBuf::from(
        common.trim(),
    ))?)
    .await;
    let local = format!("refs/heads/{work_branch}");
    let refspec = format!("{local}:{local}");
    let args = ["push", "--progress", "--", "origin", &refspec];
    repository::run(ctx, worktree_path, "push", &args, PUSH_TIMEOUT).await?;
    let head = ctx
        .git
        .run(
            worktree_path,
            &["rev-parse", "--verify", "--end-of-options", &local],
        )
        .await
        .map_err(git_failed("rev-parse"))?;
    Ok(head.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_worktrees::test_support::git_cmd;
    use crate::workspace_git::repository::{ensure, NetworkContext};
    use crate::workspace_git::test_support::{commit_file, rev_parse, Remote};

    const WORK_A: &str = "pi-desktop/aaaaaaaaaaaa";
    const WORK_B: &str = "pi-desktop/bbbbbbbbbbbb";

    struct Fixture {
        _dir: tempfile::TempDir,
        remote: Remote,
        git: GitRunner,
        main: PathBuf,
        worktrees: PathBuf,
    }

    impl Fixture {
        async fn new() -> Fixture {
            let dir = tempfile::tempdir().unwrap();
            let remote = Remote::new(dir.path());
            let git = GitRunner::default();
            let root = dir.path().join("root");
            let main = root.join("repos/github.com/octo/repo");
            let context = NetworkContext {
                git: &git,
                config: &[],
                on_progress: None,
            };
            ensure(&context, &remote.url(), &main, &|_| {})
                .await
                .unwrap();
            Fixture {
                remote,
                git,
                main,
                worktrees: root.join("worktrees/github.com/octo/repo"),
                _dir: dir,
            }
        }

        fn context(&self) -> NetworkContext<'_> {
            NetworkContext {
                git: &self.git,
                config: &[],
                on_progress: None,
            }
        }

        fn path(&self, id: &str) -> PathBuf {
            self.worktrees.join(id)
        }

        fn local_branch_exists(&self, branch: &str) -> bool {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&self.main)
                .args(["show-ref", "--verify", "--quiet"])
                .arg(format!("refs/heads/{branch}"))
                .status()
                .unwrap()
                .success()
        }
    }

    #[tokio::test]
    async fn create_checks_out_the_work_branch_at_the_base_commit() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        let base = create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("main"),
        )
        .await
        .unwrap();
        assert_eq!(base, f.remote.head("main"));
        assert_eq!(rev_parse(&a, "HEAD"), base);
        assert_eq!(
            git_cmd(&a, &["symbolic-ref", "--short", "HEAD"]).trim(),
            WORK_A
        );
        // A second session from another base branch coexists with the first.
        let b = f.path("bbbbbbbbbbbb");
        let base_b = create(
            &f.git,
            &f.main,
            &b,
            WORK_B,
            StartPoint::RemoteBranch("develop"),
        )
        .await
        .unwrap();
        assert_eq!(base_b, f.remote.head("develop"));
        assert!(b.join("develop.txt").is_file());
        assert!(!a.join("develop.txt").exists());
        assert_eq!(rev_parse(&a, "HEAD"), base);
        assert_eq!(git_cmd(&f.main, &["worktree", "list"]).lines().count(), 3);
        // The main checkout stays on its default branch, untouched.
        assert_eq!(
            git_cmd(&f.main, &["symbolic-ref", "--short", "HEAD"]).trim(),
            "main"
        );
        // git must not prune a worktree whose directory is briefly unreachable.
        assert!(git_cmd(&f.main, &["worktree", "list", "--porcelain"]).contains("locked"));
    }

    #[tokio::test]
    async fn a_bare_push_inside_the_worktree_targets_the_work_branch() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("main"),
        )
        .await
        .unwrap();
        assert_eq!(
            git_cmd(
                &f.main,
                &["config", "--get", &format!("branch.{WORK_A}.remote")]
            )
            .trim(),
            "origin"
        );
        assert_eq!(
            git_cmd(
                &f.main,
                &["config", "--get", &format!("branch.{WORK_A}.merge")]
            )
            .trim(),
            format!("refs/heads/{WORK_A}")
        );
        let head = commit_file(&a, "work.txt", "work\n");
        let main_before = f.remote.head("main");
        git_cmd(&a, &["-c", "push.default=simple", "push", "-q"]);
        assert_eq!(f.remote.head(WORK_A), head);
        assert_eq!(f.remote.head("main"), main_before);
    }

    #[tokio::test]
    async fn create_on_a_missing_base_reports_branch_not_found_and_leaves_nothing() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        let error = create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("no-such-branch"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_BRANCH_NOT_FOUND", "{error}");
        assert!(!a.exists());
        assert!(!f.local_branch_exists(WORK_A));
        assert_eq!(git_cmd(&f.main, &["worktree", "list"]).lines().count(), 1);
        // A name that is not a branch name never reaches git.
        for bad in ["-x", "a..b", "../../etc", "a.lock"] {
            let error = create(&f.git, &f.main, &a, WORK_A, StartPoint::RemoteBranch(bad))
                .await
                .unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{bad}");
            let error = create(&f.git, &f.main, &a, bad, StartPoint::RemoteBranch("main"))
                .await
                .unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{bad}");
        }
        assert!(!a.exists());
    }

    #[tokio::test]
    async fn create_can_start_from_another_sessions_local_work_branch() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("main"),
        )
        .await
        .unwrap();
        // Never pushed: the commit exists only on the host.
        let unpushed = commit_file(&a, "parent.txt", "parent\n");
        let b = f.path("bbbbbbbbbbbb");
        let base = create(&f.git, &f.main, &b, WORK_B, StartPoint::LocalBranch(WORK_A))
            .await
            .unwrap();
        assert_eq!(base, unpushed);
        assert_eq!(rev_parse(&b, "HEAD"), unpushed);
        assert_eq!(
            git_cmd(&b, &["symbolic-ref", "--short", "HEAD"]).trim(),
            WORK_B
        );
        assert!(b.join("parent.txt").is_file());
        // The child has its own branch: its upstream is its own name.
        assert_eq!(
            git_cmd(
                &f.main,
                &["config", "--get", &format!("branch.{WORK_B}.merge")]
            )
            .trim(),
            format!("refs/heads/{WORK_B}")
        );
        // A session whose branch is gone cannot be a starting point.
        let c = f.path("cccccccccccc");
        let error = create(
            &f.git,
            &f.main,
            &c,
            "pi-desktop/cccccccccccc",
            StartPoint::LocalBranch("pi-desktop/dddddddddddd"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_NOT_FOUND", "{error}");
        assert!(!c.exists());
    }

    #[tokio::test]
    async fn create_preserves_an_unregistered_checkout_and_restore_keeps_commits() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("main"),
        )
        .await
        .unwrap();
        let head = commit_file(&a, "unpushed.txt", "do not lose this");
        assert!(create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("develop")
        )
        .await
        .is_err());
        assert_eq!(rev_parse(&a, "HEAD"), head);
        fs::remove_dir_all(&a).unwrap();
        assert_eq!(unpushed_commits(&f.git, &f.main, WORK_A).await.unwrap(), 1);
        restore(&f.git, &f.main, &a, WORK_A).await.unwrap();
        assert_eq!(rev_parse(&a, "HEAD"), head);
    }

    #[tokio::test]
    async fn status_counts_local_work_and_follows_pushes() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("main"),
        )
        .await
        .unwrap();
        let clean = status(&f.git, &a, WORK_A).await.unwrap();
        assert_eq!(
            clean,
            StatusCounts {
                ahead: 0,
                behind: 0,
                uncommitted_files: 0,
                unpushed_commits: 0,
                pushed_once: false,
            }
        );

        std::fs::write(a.join("untracked.txt"), "u\n").unwrap();
        std::fs::write(a.join("README.md"), "changed\n").unwrap();
        let dirty = status(&f.git, &a, WORK_A).await.unwrap();
        assert_eq!(dirty.uncommitted_files, 2);
        assert_eq!(dirty.unpushed_commits, 0);

        std::fs::remove_file(a.join("untracked.txt")).unwrap();
        let first = commit_file(&a, "README.md", "changed\n");
        commit_file(&a, "second.txt", "2\n");
        let committed = status(&f.git, &a, WORK_A).await.unwrap();
        assert_eq!(
            committed,
            StatusCounts {
                ahead: 0,
                behind: 0,
                uncommitted_files: 0,
                unpushed_commits: 2,
                pushed_once: false,
            }
        );

        let head = rev_parse(&a, "HEAD");
        assert_eq!(push(&f.context(), &a, WORK_A).await.unwrap(), head);
        assert_eq!(f.remote.head(WORK_A), head);
        let pushed = status(&f.git, &a, WORK_A).await.unwrap();
        assert_eq!(
            pushed,
            StatusCounts {
                ahead: 0,
                behind: 0,
                uncommitted_files: 0,
                unpushed_commits: 0,
                pushed_once: true,
            }
        );

        commit_file(&a, "third.txt", "3\n");
        let ahead = status(&f.git, &a, WORK_A).await.unwrap();
        assert_eq!(
            (ahead.ahead, ahead.behind, ahead.unpushed_commits),
            (1, 0, 1)
        );
        assert!(ahead.pushed_once);

        // Rewinding below the pushed head: one commit behind the remote branch.
        git_cmd(&a, &["reset", "-q", "--hard", &first]);
        let behind = status(&f.git, &a, WORK_A).await.unwrap();
        assert_eq!(
            (behind.ahead, behind.behind, behind.unpushed_commits),
            (0, 1, 0)
        );

        // A rename is one changed file, not two.
        git_cmd(&a, &["mv", "README.md", "README.rst"]);
        assert_eq!(
            status(&f.git, &a, WORK_A).await.unwrap().uncommitted_files,
            1
        );
    }

    #[tokio::test]
    async fn push_sends_only_the_work_branch() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("main"),
        )
        .await
        .unwrap();
        let main_before = f.remote.head("main");
        let head = commit_file(&a, "work.txt", "work\n");
        assert!(!f.remote.has_branch(WORK_A));
        assert_eq!(push(&f.context(), &a, WORK_A).await.unwrap(), head);
        assert_eq!(f.remote.head(WORK_A), head);
        assert_eq!(f.remote.head("main"), main_before);
        // Pushing again with nothing new still reports the remote head.
        assert_eq!(push(&f.context(), &a, WORK_A).await.unwrap(), head);
    }

    #[tokio::test]
    async fn remove_deletes_the_directory_and_branch_and_spares_other_worktrees() {
        let f = Fixture::new().await;
        let a = f.path("aaaaaaaaaaaa");
        let b = f.path("bbbbbbbbbbbb");
        create(
            &f.git,
            &f.main,
            &a,
            WORK_A,
            StartPoint::RemoteBranch("main"),
        )
        .await
        .unwrap();
        create(
            &f.git,
            &f.main,
            &b,
            WORK_B,
            StartPoint::RemoteBranch("develop"),
        )
        .await
        .unwrap();
        commit_file(&a, "work.txt", "work\n");
        std::fs::write(a.join("scratch.txt"), "s\n").unwrap();
        let b_head = rev_parse(&b, "HEAD");

        remove(&f.git, &f.main, &a, WORK_A).await.unwrap();
        assert!(!a.exists());
        assert!(!f.local_branch_exists(WORK_A));
        assert!(b.join("develop.txt").is_file());
        assert_eq!(rev_parse(&b, "HEAD"), b_head);
        assert!(f.local_branch_exists(WORK_B));
        assert_eq!(git_cmd(&f.main, &["worktree", "list"]).lines().count(), 2);
        assert!(f.main.join("README.md").is_file());
        // Removing what is already gone is not an error.
        remove(&f.git, &f.main, &a, WORK_A).await.unwrap();
    }
}
