//! The only way host-core runs git for isolated worktrees (ADR 0329).
//!
//! Every invocation is non-interactive and hardened, because host-core runs
//! these commands on the user's behalf without a permission card:
//!
//! - hooks are disabled. A relative `core.hooksPath` (husky style) resolves
//!   inside the worktree, so a hook file written with Write/Edit alone would
//!   otherwise run here and bypass the Bash permission;
//! - `core.fsmonitor` is disabled, since it is a config-defined command;
//! - `safe.bareRepository=explicit` refuses implicitly discovered bare
//!   repositories;
//! - variables that redirect git to another repository or index are removed.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

#[cfg(windows)]
const NULL_HOOKS_PATH: &str = "NUL";
#[cfg(not(windows))]
const NULL_HOOKS_PATH: &str = "/dev/null";

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Environment that would point git at another repository, index, or config.
const REDIRECT_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git executable was not found")]
    Missing,
    #[error("git could not be started: {0}")]
    Spawn(std::io::Error),
    #[error("git {args} timed out after {secs}s")]
    Timeout { args: String, secs: u64 },
    #[error("git {args} failed with exit code {status}: {stderr}")]
    Failed {
        args: String,
        status: i32,
        stdout: String,
        stderr: String,
    },
}

impl GitError {
    pub fn code(&self) -> &'static str {
        match self {
            GitError::Missing => "WORKTREE_GIT_MISSING",
            GitError::Spawn(_) | GitError::Failed { .. } => "WORKTREE_GIT_FAILED",
            GitError::Timeout { .. } => "WORKTREE_GIT_TIMEOUT",
        }
    }
}

/// Raw result of a git command that is allowed to exit non-zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

#[derive(Debug, Clone)]
pub struct GitRunner {
    program: PathBuf,
    path_env: Option<String>,
    timeout: Duration,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
            // GUI launches lack the terminal PATH; use the login PATH the Bash
            // tool already uses (D181) so the same git is found.
            path_env: crate::tools::shell::user_login_path().map(str::to_string),
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

impl GitRunner {
    #[cfg(test)]
    pub fn with_program(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            ..Self::default()
        }
    }

    /// Run git in `dir` and return stdout; a non-zero exit is an error.
    pub async fn run(&self, dir: &Path, args: &[&str]) -> Result<String, GitError> {
        Self::checked(args, self.output(dir, args).await?)
    }

    /// Run git against an explicit git directory (`--git-dir`), for work that
    /// must not depend on a working tree that may already be gone.
    pub async fn run_git_dir(&self, git_dir: &Path, args: &[&str]) -> Result<String, GitError> {
        Self::checked(
            args,
            self.spawn(self.command(Location::GitDir(git_dir), args), args, None)
                .await?,
        )
    }

    fn checked(args: &[&str], output: GitOutput) -> Result<String, GitError> {
        if output.success() {
            Ok(output.stdout)
        } else {
            Err(GitError::Failed {
                args: args.join(" "),
                status: output.status,
                stdout: output.stdout,
                stderr: output.stderr.trim().to_string(),
            })
        }
    }

    /// Run git in `dir` and return its exit status and output.
    pub async fn output(&self, dir: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
        self.spawn(self.command(Location::WorkTree(dir), args), args, None)
            .await
    }

    /// Like `output`, with `input` written to git's stdin (for `--stdin`).
    pub async fn output_with_input(
        &self,
        dir: &Path,
        args: &[&str],
        input: Vec<u8>,
    ) -> Result<GitOutput, GitError> {
        let mut command = self.command(Location::WorkTree(dir), args);
        command.stdin(Stdio::piped());
        self.spawn(command, args, Some(input)).await
    }

    async fn spawn(
        &self,
        mut command: Command,
        args: &[&str],
        input: Option<Vec<u8>>,
    ) -> Result<GitOutput, GitError> {
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitError::Missing
            } else {
                GitError::Spawn(error)
            }
        })?;
        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            // Written concurrently with reading output so a large input cannot
            // deadlock against a full output pipe.
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(&input).await;
            });
        }
        let output = tokio::time::timeout(self.timeout, child.wait_with_output())
            .await
            .map_err(|_| GitError::Timeout {
                args: args.join(" "),
                secs: self.timeout.as_secs(),
            })?
            .map_err(GitError::Spawn)?;
        Ok(GitOutput {
            // A signal-terminated git has no code; report it as a failure.
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    fn command(&self, location: Location<'_>, args: &[&str]) -> Command {
        let mut command = Command::new(&self.program);
        match location {
            Location::WorkTree(dir) => {
                command.arg("-C").arg(dir);
            }
            Location::GitDir(git_dir) => {
                let mut flag = std::ffi::OsString::from("--git-dir=");
                flag.push(git_dir);
                command.arg(flag);
            }
        }
        command.args([
            "-c",
            &format!("core.hooksPath={NULL_HOOKS_PATH}"),
            "-c",
            "core.fsmonitor=false",
            "-c",
            "safe.bareRepository=explicit",
        ]);
        #[cfg(windows)]
        command.args(["-c", "core.longpaths=true"]);
        command.args(args);
        for name in REDIRECT_ENV {
            command.env_remove(name);
        }
        command
            .env("GIT_TERMINAL_PROMPT", "0")
            // Background reads must not take the index lock (git-status(1),
            // "BACKGROUND REFRESH"); required locks are unaffected.
            .env("GIT_OPTIONAL_LOCKS", "0")
            // Stable, parseable messages regardless of the user's locale.
            .env("LC_ALL", "C");
        if let Some(path) = self.path_env.as_deref() {
            command.env("PATH", path);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        command
    }
}

#[derive(Clone, Copy)]
enum Location<'a> {
    WorkTree(&'a Path),
    GitDir(&'a Path),
}

/// Parse `git version 2.51.0`, `git version 2.39.3 (Apple Git-146)`, or
/// `git version 2.45.1.windows.1` into `(major, minor)`.
pub fn parse_version(text: &str) -> Option<(u32, u32)> {
    let version = text.trim().strip_prefix("git version ")?;
    let mut parts = version.split(|c: char| c == '.' || c.is_whitespace());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_worktrees::test_support::init_repo;

    #[test]
    fn parses_release_vendor_and_windows_versions() {
        assert_eq!(parse_version("git version 2.51.0\n"), Some((2, 51)));
        assert_eq!(
            parse_version("git version 2.39.3 (Apple Git-146)"),
            Some((2, 39))
        );
        assert_eq!(parse_version("git version 2.45.1.windows.1"), Some((2, 45)));
        assert_eq!(parse_version("not git"), None);
    }

    #[tokio::test]
    async fn a_missing_executable_is_reported_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let git = GitRunner::with_program(dir.path().join("no-such-git"));
        let error = git.run(dir.path(), &["--version"]).await.unwrap_err();
        assert_eq!(error.code(), "WORKTREE_GIT_MISSING");
    }

    /// AC13: a hook file the agent could write with Write/Edit alone (a
    /// relative, husky-style `core.hooksPath` inside the worktree) must not run
    /// when host-core commits, checks out, or merges. Git for Windows runs
    /// such a hook through its bundled `sh` without an executable bit.
    #[tokio::test]
    async fn host_initiated_commit_and_merge_never_run_repository_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let git = GitRunner::default();
        git.run(&repo, &["config", "core.hooksPath", ".husky/_"])
            .await
            .unwrap();
        let marker = dir.path().join("hook-ran");
        // `sh` on Windows takes forward slashes.
        let marker_for_sh = marker.display().to_string().replace('\\', "/");
        let hooks = repo.join(".husky/_");
        std::fs::create_dir_all(&hooks).unwrap();
        for hook in [
            "pre-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-commit",
            "pre-merge-commit",
            "post-merge",
            "post-checkout",
        ] {
            let script = hooks.join(hook);
            std::fs::write(
                &script,
                format!("#!/bin/sh\necho {hook} >> '{marker_for_sh}'\nexit 1\n"),
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        commit_all_with(&git, &repo, "a").await;
        git.run(&repo, &["checkout", "-q", "-b", "side", "HEAD~1"])
            .await
            .unwrap();
        std::fs::write(repo.join("b.txt"), "b").unwrap();
        commit_all_with(&git, &repo, "b").await;
        git.run(&repo, &["merge", "-q", "--no-edit", "main"])
            .await
            .unwrap();
        assert!(
            !marker.exists(),
            "a repository hook ran during a host git command: {:?}",
            std::fs::read_to_string(&marker).ok()
        );
    }

    async fn commit_all_with(git: &GitRunner, repo: &Path, message: &str) {
        git.run(repo, &["add", "-A", "--", ".", ":!.husky"])
            .await
            .unwrap();
        git.run(repo, &["commit", "-q", "-m", message])
            .await
            .unwrap();
    }

    #[test]
    fn every_command_removes_repository_redirect_variables() {
        let runner = GitRunner::default();
        let command = runner.command(Location::WorkTree(Path::new(".")), &["status"]);
        let envs: Vec<_> = command.as_std().get_envs().collect();
        for name in REDIRECT_ENV {
            assert!(
                envs.iter()
                    .any(|(key, value)| *key == std::ffi::OsStr::new(name) && value.is_none()),
                "{name} is not removed"
            );
        }
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&format!("core.hooksPath={NULL_HOOKS_PATH}")));
        assert!(args.contains(&"core.fsmonitor=false".to_string()));
        assert!(args.contains(&"safe.bareRepository=explicit".to_string()));
    }
}
