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

/// Programs git would run to ask for a credential. A network command must
/// fail closed instead of opening a prompt nobody is there to answer.
const PROMPT_ENV: &[&str] = &["GIT_ASKPASS", "SSH_ASKPASS"];

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

    /// Like `run_network_with_progress`, discarding incremental stderr callbacks.
    #[cfg(test)]
    pub async fn run_network(
        &self,
        dir: &Path,
        config: &[(&str, &str)],
        args: &[&str],
        timeout: Duration,
    ) -> Result<GitOutput, GitError> {
        self.run_network_with_progress(dir, config, args, timeout, |_| {})
            .await
    }

    /// Run a clone, fetch, or push in `dir` with a caller-chosen limit and
    /// per-command configuration, streaming each `\r`- or `\n`-delimited stderr
    /// segment to `on_stderr_line` while preserving the full raw stderr in
    /// `GitOutput`.
    ///
    /// `config` reaches git as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` /
    /// `GIT_CONFIG_VALUE_<n>` on the child only, not as `-c`: a process
    /// argument list is readable by other local users, and the value carries
    /// the credential proxy handle. Inherited environment configuration is
    /// still removed, and every other safety flag still applies.
    ///
    /// git does its transfer in helper processes (`git remote-http`,
    /// `git index-pack`). On Unix the command therefore runs in its own
    /// process group, and the whole group is killed when the limit passes or
    /// the returned future is dropped (a cancelled job): killing git alone
    /// would leave the helpers transferring.
    pub async fn run_network_with_progress<F>(
        &self,
        dir: &Path,
        config: &[(&str, &str)],
        args: &[&str],
        timeout: Duration,
        mut on_stderr_line: F,
    ) -> Result<GitOutput, GitError>
    where
        F: FnMut(&str) + Send,
    {
        use tokio::io::AsyncReadExt;
        let mut command = self.network_command(dir, config, args);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitError::Missing
            } else {
                GitError::Spawn(error)
            }
        })?;
        // Declared after `child`, so it is dropped first: the group is
        // signalled while its leader is still unreaped, which is what keeps
        // the group id from having been reused.
        let group = ProcessGroup::of(&child);
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let finished = async {
            let stdout = stdout.take();
            let stderr = stderr.take();
            let read_stdout = async {
                let mut bytes = Vec::new();
                if let Some(mut pipe) = stdout {
                    let _ = pipe.read_to_end(&mut bytes).await;
                }
                bytes
            };
            let read_stderr = async {
                let mut bytes = Vec::new();
                let mut pending = Vec::new();
                if let Some(mut pipe) = stderr {
                    let mut buf = [0u8; 4096];
                    loop {
                        match pipe.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => {
                                let chunk = &buf[..n];
                                bytes.extend_from_slice(chunk);
                                for &byte in chunk {
                                    if byte == b'\r' || byte == b'\n' {
                                        if !pending.is_empty() {
                                            let line = String::from_utf8_lossy(&pending);
                                            on_stderr_line(&line);
                                            pending.clear();
                                        }
                                    } else {
                                        pending.push(byte);
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
                if !pending.is_empty() {
                    let line = String::from_utf8_lossy(&pending);
                    on_stderr_line(&line);
                }
                bytes
            };
            tokio::join!(child.wait(), read_stdout, read_stderr)
        };
        let (status, stdout, stderr) =
            tokio::time::timeout(timeout, finished)
                .await
                .map_err(|_| GitError::Timeout {
                    args: args.join(" "),
                    secs: timeout.as_secs(),
                })?;
        let status = status.map_err(GitError::Spawn)?;
        // git ended by itself; there is nothing left to kill.
        group.disarm();
        Ok(GitOutput {
            status: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    fn network_command(&self, dir: &Path, config: &[(&str, &str)], args: &[&str]) -> Command {
        // `command` removes the inherited `GIT_CONFIG_COUNT`; it is set again
        // below only when the caller supplied configuration.
        let mut command = self.command(Location::WorkTree(dir), args);
        for name in PROMPT_ENV {
            command.env_remove(name);
        }
        if !config.is_empty() {
            command.env("GIT_CONFIG_COUNT", config.len().to_string());
            for (index, (key, value)) in config.iter().enumerate() {
                command.env(format!("GIT_CONFIG_KEY_{index}"), key);
                command.env(format!("GIT_CONFIG_VALUE_{index}"), value);
            }
        }
        command
    }

    async fn spawn(
        &self,
        command: Command,
        args: &[&str],
        input: Option<Vec<u8>>,
    ) -> Result<GitOutput, GitError> {
        self.spawn_within(command, args, input, self.timeout).await
    }

    async fn spawn_within(
        &self,
        mut command: Command,
        args: &[&str],
        input: Option<Vec<u8>>,
        timeout: Duration,
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
        let output = tokio::time::timeout(timeout, child.wait_with_output())
            .await
            .map_err(|_| GitError::Timeout {
                args: args.join(" "),
                secs: timeout.as_secs(),
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

/// The process group of a running network git. Dropping it while armed sends
/// `SIGKILL` to every process in the group.
struct ProcessGroup {
    #[cfg(unix)]
    id: Option<i32>,
}

impl ProcessGroup {
    fn of(child: &tokio::process::Child) -> Self {
        #[cfg(not(unix))]
        let _ = child;
        Self {
            #[cfg(unix)]
            id: child.id().and_then(|id| i32::try_from(id).ok()),
        }
    }

    fn disarm(mut self) {
        #[cfg(unix)]
        {
            self.id = None;
        }
        #[cfg(not(unix))]
        let _ = &mut self;
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.id.take() {
            // SAFETY: `killpg` only sends a signal. The group was created by
            // this process for a child it has not reaped yet, so the id still
            // names that group.
            unsafe {
                libc::killpg(id, libc::SIGKILL);
            }
        }
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

    /// A stand-in for git that reports its own arguments and environment.
    #[cfg(unix)]
    fn stub_git(dir: &Path, body: &str) -> GitRunner {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("git-stub");
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        GitRunner::with_program(script)
    }

    #[cfg(unix)]
    const REPORT: &str = "for arg in \"$@\"; do printf 'ARG:%s\\n' \"$arg\"; done\nenv";

    const PROXY_KEY: &str = "url.http://127.0.0.1:1/handle-0123/o/r.git.insteadOf";
    const PROXY_VALUE: &str = "https://github.com/o/r.git";

    #[cfg(unix)]
    #[tokio::test]
    async fn network_configuration_reaches_git_through_the_environment_only() {
        let dir = tempfile::tempdir().unwrap();
        let git = stub_git(dir.path(), REPORT);
        let config = [(PROXY_KEY, PROXY_VALUE), ("http.lowSpeedLimit", "1")];
        let output = git
            .run_network(
                dir.path(),
                &config,
                &["fetch", "--prune", "--", "origin"],
                Duration::from_secs(30),
            )
            .await
            .unwrap();
        assert!(output.success(), "{output:?}");
        let lines: Vec<&str> = output.stdout.lines().collect();
        for expected in [
            "GIT_CONFIG_COUNT=2".to_string(),
            format!("GIT_CONFIG_KEY_0={PROXY_KEY}"),
            format!("GIT_CONFIG_VALUE_0={PROXY_VALUE}"),
            "GIT_CONFIG_KEY_1=http.lowSpeedLimit".to_string(),
            "GIT_CONFIG_VALUE_1=1".to_string(),
            "GIT_TERMINAL_PROMPT=0".to_string(),
        ] {
            assert!(lines.contains(&expected.as_str()), "missing {expected}");
        }
        // The value carries the proxy handle, and a process argument list is
        // readable by other local users: it must never be an argument.
        let args: Vec<&str> = lines
            .iter()
            .filter_map(|line| line.strip_prefix("ARG:"))
            .collect();
        assert!(
            args.iter()
                .all(|arg| !arg.contains("handle-0123") && !arg.contains("insteadOf")),
            "{args:?}"
        );
        // Every existing safety flag is still passed, before the subcommand.
        let position = |needle: &str| args.iter().position(|arg| *arg == needle);
        let fetch = position("fetch").expect("subcommand is passed");
        for flag in [
            format!("core.hooksPath={NULL_HOOKS_PATH}"),
            "core.fsmonitor=false".to_string(),
            "safe.bareRepository=explicit".to_string(),
        ] {
            assert!(position(&flag).is_some_and(|at| at < fetch), "{flag}");
        }
        assert_eq!(&args[fetch..], ["fetch", "--prune", "--", "origin"]);
    }

    #[test]
    fn network_commands_never_inherit_git_configuration_from_the_parent() {
        let runner = GitRunner::default();
        let env_of = |command: &Command, name: &str| -> Option<Option<String>> {
            command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new(name))
                .map(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
        };
        // With configuration, the count is set explicitly on the child, so a
        // parent's `GIT_CONFIG_COUNT=7` cannot be the one git reads.
        let with = runner.network_command(Path::new("."), &[(PROXY_KEY, PROXY_VALUE)], &["fetch"]);
        assert_eq!(env_of(&with, "GIT_CONFIG_COUNT"), Some(Some("1".into())));
        assert_eq!(
            env_of(&with, "GIT_CONFIG_KEY_0"),
            Some(Some(PROXY_KEY.into()))
        );
        // Without configuration, the inherited count is removed outright.
        let without = runner.network_command(Path::new("."), &[], &["fetch"]);
        assert_eq!(env_of(&without, "GIT_CONFIG_COUNT"), Some(None));
        for command in [&with, &without] {
            for name in REDIRECT_ENV {
                if *name == "GIT_CONFIG_COUNT" {
                    continue;
                }
                assert_eq!(env_of(command, name), Some(None), "{name} is not removed");
            }
            // A graphical or scripted credential prompt must not answer for a
            // git that is supposed to fail closed.
            for name in ["GIT_ASKPASS", "SSH_ASKPASS"] {
                assert_eq!(env_of(command, name), Some(None), "{name} is not removed");
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_network_command_stops_at_the_callers_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let git = stub_git(dir.path(), "exec sleep 30");
        let started = std::time::Instant::now();
        let error = git
            .run_network(
                dir.path(),
                &[(PROXY_KEY, PROXY_VALUE)],
                &["clone", "--", "https://github.com/o/r.git", "target"],
                Duration::from_millis(300),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "WORKTREE_GIT_TIMEOUT");
        assert!(matches!(error, GitError::Timeout { .. }));
        assert!(started.elapsed() < Duration::from_millis(2300));
        // The timeout message names the subcommand, never the configuration.
        assert!(!error.to_string().contains("handle-0123"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_network_command_returns_its_status_and_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let git = stub_git(dir.path(), "echo 'fatal: nope' >&2\nexit 128");
        let output = git
            .run_network(dir.path(), &[], &["fetch"], Duration::from_secs(30))
            .await
            .unwrap();
        assert_eq!(output.status, 128);
        assert_eq!(output.stderr.trim(), "fatal: nope");
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
