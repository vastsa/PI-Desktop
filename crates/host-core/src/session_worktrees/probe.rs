//! Decide whether a project can host isolated sessions, and where its
//! repository lives (ADR 0329, PRD R6).

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::git::{parse_version, GitError, GitRunner};

/// `git worktree repair` (used after a project or data directory moves) was
/// added in git 2.29.0.
pub const MIN_GIT_VERSION: (u32, u32) = (2, 29);

/// Every branch host-core creates lives under this namespace.
pub const BRANCH_NAMESPACE: &str = "pi-desktop";

/// Where an isolatable project lives inside its repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Canonical repository top level (`git rev-parse --show-toplevel`).
    pub toplevel: PathBuf,
    /// Project directory relative to `toplevel`, `/`-separated with a
    /// trailing slash, empty when the project is the top level.
    pub prefix: String,
    /// Canonical common git directory; the key for per-repository
    /// serialization of mutating git commands.
    pub common_dir: PathBuf,
    /// Branch currently checked out in the project.
    pub branch: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("git {found_major}.{found_minor} is older than the required 2.29")]
    GitTooOld { found_major: u32, found_minor: u32 },
    #[error("the project is not inside a git working tree")]
    NotGit,
    #[error("the repository has no commits yet")]
    NoCommits,
    #[error("the project is on a detached HEAD; check out a branch first")]
    DetachedHead,
    #[error("a branch named `pi-desktop` exists, so `pi-desktop/...` branches cannot be created")]
    BranchNamespaceTaken,
    #[error(transparent)]
    Git(#[from] GitError),
}

impl ProbeError {
    pub fn code(&self) -> &'static str {
        match self {
            ProbeError::GitTooOld { .. } => "WORKTREE_GIT_TOO_OLD",
            ProbeError::NotGit => "WORKTREE_NOT_GIT",
            ProbeError::NoCommits => "WORKTREE_NO_COMMITS",
            ProbeError::DetachedHead => "WORKTREE_DETACHED_HEAD",
            ProbeError::BranchNamespaceTaken => "WORKTREE_BRANCH_NAMESPACE_TAKEN",
            ProbeError::Git(error) => error.code(),
        }
    }
}

pub async fn probe(git: &GitRunner, project: &Path) -> Result<RepoInfo, ProbeError> {
    let version = git.run(project, &["--version"]).await?;
    if let Some((major, minor)) = parse_version(&version) {
        if (major, minor) < MIN_GIT_VERSION {
            return Err(ProbeError::GitTooOld {
                found_major: major,
                found_minor: minor,
            });
        }
    }

    let inside = git
        .output(project, &["rev-parse", "--is-inside-work-tree"])
        .await?;
    if !inside.success() || inside.stdout.trim() != "true" {
        return Err(ProbeError::NotGit);
    }

    let has_commit = git
        .output(
            project,
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        )
        .await?;
    if !has_commit.success() {
        return Err(ProbeError::NoCommits);
    }

    // The full ref, not `--short`: that prints `heads/<name>` when a tag
    // shares the branch's name.
    let head = git
        .output(project, &["symbolic-ref", "--quiet", "HEAD"])
        .await?;
    let branch = match head.stdout.trim().strip_prefix("refs/heads/") {
        Some(branch) if head.success() => branch.to_string(),
        _ => return Err(ProbeError::DetachedHead),
    };

    let namespace = git
        .output(
            project,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{BRANCH_NAMESPACE}"),
            ],
        )
        .await?;
    if namespace.success() {
        return Err(ProbeError::BranchNamespaceTaken);
    }

    let toplevel = git.run(project, &["rev-parse", "--show-toplevel"]).await?;
    let prefix = git.run(project, &["rev-parse", "--show-prefix"]).await?;
    let common_dir = git.run(project, &["rev-parse", "--git-common-dir"]).await?;
    Ok(RepoInfo {
        toplevel: canonical(Path::new(toplevel.trim())),
        prefix: prefix.trim().to_string(),
        // Relative from a subdirectory (for example `../../.git`); git 2.29
        // has no `--path-format=absolute`, so resolve it here.
        common_dir: canonical(&project.join(common_dir.trim())),
        branch,
    })
}

fn canonical(path: &Path) -> PathBuf {
    crate::workspace::simple_canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_worktrees::test_support::{git_cmd, init_repo};

    async fn probe_code(path: &Path) -> &'static str {
        probe(&GitRunner::default(), path)
            .await
            .map(|_| "OK")
            .unwrap_or_else(|error| error.code())
    }

    #[tokio::test]
    async fn rejects_projects_that_cannot_host_a_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(probe_code(&plain).await, "WORKTREE_NOT_GIT");

        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        git_cmd(&empty, &["init", "-q", "-b", "main"]);
        assert_eq!(probe_code(&empty).await, "WORKTREE_NO_COMMITS");

        let detached = init_repo(&dir.path().join("detached"));
        git_cmd(&detached, &["checkout", "-q", "--detach"]);
        assert_eq!(probe_code(&detached).await, "WORKTREE_DETACHED_HEAD");

        let taken = init_repo(&dir.path().join("taken"));
        git_cmd(&taken, &["branch", "pi-desktop"]);
        assert_eq!(probe_code(&taken).await, "WORKTREE_BRANCH_NAMESPACE_TAKEN");
    }

    #[tokio::test]
    async fn reports_root_prefix_branch_and_absolute_common_dir() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(&dir.path().join("repo"));
        let info = probe(&GitRunner::default(), &repo).await.unwrap();
        assert_eq!(info.toplevel, canonical(&repo));
        assert_eq!(info.prefix, "");
        assert_eq!(info.branch, "main");
        assert_eq!(info.common_dir, canonical(&repo.join(".git")));
    }

    /// AC20 / design §15 F1–F3: a project that is a monorepo subdirectory.
    #[tokio::test]
    async fn a_repository_subdirectory_reports_its_prefix_and_shared_common_dir() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(&dir.path().join("mono"));
        let app = repo.join("packages/app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("a.txt"), "a").unwrap();
        git_cmd(&repo, &["add", "-A"]);
        git_cmd(&repo, &["commit", "-q", "-m", "app"]);
        let info = probe(&GitRunner::default(), &app).await.unwrap();
        assert_eq!(info.toplevel, canonical(&repo));
        assert_eq!(info.prefix, "packages/app/");
        assert_eq!(info.common_dir, canonical(&repo.join(".git")));
    }
}
