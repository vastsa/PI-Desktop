//! The main checkout of a repository: cloned once, fetched afterwards.
//!
//! Clone, fetch, and push are the only git commands that leave the host. They
//! run through `GitRunner::run_network` with the caller's configuration, which
//! is how the credential proxy rewrite arrives; this module never sees a
//! credential.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::jobs::JobProgress;
use super::WorkspaceGitError;
use crate::session_worktrees::git::{parse_version, GitError, GitOutput, GitRunner};
use crate::session_worktrees::repo_lock;

/// `GIT_CONFIG_COUNT`, which carries the proxy rewrite to host-run git and to
/// the agent's own git, was added in git 2.31.0. An older git would ignore it
/// and talk to GitHub directly without a credential.
pub const MIN_GIT_VERSION: (u32, u32) = (2, 31);

pub const CLONE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// How much of git's output a failure message keeps.
const STDERR_TAIL_BYTES: usize = 2 * 1024;

/// What a network git command runs with: the runner and the per-command
/// configuration (the proxy rewrite, or nothing in tests).
#[derive(Clone, Copy)]
pub struct NetworkContext<'a> {
    pub git: &'a GitRunner,
    pub config: &'a [(&'a str, &'a str)],
    pub on_progress: Option<&'a (dyn Fn(JobProgress) + Send + Sync)>,
}

const KNOWN_PROGRESS_PHASES: &[&str] = &[
    "Counting objects",
    "Compressing objects",
    "Receiving objects",
    "Resolving deltas",
    "Writing objects",
    "Updating files",
    "Enumerating objects",
    "Filtering content",
    "Checking out files",
];

/// Parse one stderr line emitted by `git --progress` into a safe `JobProgress`.
/// Only known git phase names are emitted so proxy URLs or paths never leak into `detail`.
pub(crate) fn parse_git_progress(line: &str) -> Option<JobProgress> {
    let trimmed = line.trim();
    let body = trimmed
        .strip_prefix("remote:")
        .map(str::trim_start)
        .unwrap_or(trimmed);
    let (phase, rest) = KNOWN_PROGRESS_PHASES.iter().find_map(|&phase| {
        let rest = body.strip_prefix(phase)?.strip_prefix(':')?;
        Some((phase, rest.trim_start()))
    })?;
    let digit_len = rest
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digit_len == 0 {
        return None;
    }
    let digits = &rest[..digit_len];
    let after = &rest[digit_len..];
    let percent = if after.starts_with('%') {
        let value: u32 = digits.parse().ok()?;
        if value > 100 {
            return None;
        }
        Some(value as u8)
    } else if after.is_empty()
        || after.starts_with(',')
        || after.starts_with(' ')
        || after.starts_with('(')
    {
        None
    } else {
        return None;
    };
    Some(JobProgress {
        percent,
        detail: Some(phase.to_string()),
    })
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Cloning,
    Fetching,
}

/// The git directory of a main checkout: the key for serializing every
/// repository-changing step, shared by all of its worktrees.
pub fn common_dir(main_path: &Path) -> PathBuf {
    let git_dir = main_path.join(".git");
    if let Ok(canonical) = crate::workspace::simple_canonicalize(&git_dir) {
        return canonical;
    }
    // A new clone does not have a git directory yet. Canonicalize the
    // existing parent so a symlinked workspaces root uses the same lock.
    match (main_path.parent(), main_path.file_name()) {
        (Some(parent), Some(name)) => crate::workspace::simple_canonicalize(parent)
            .map(|parent| parent.join(name).join(".git"))
            .unwrap_or(git_dir),
        _ => git_dir,
    }
}

/// Make sure `main_path` is a clone of `remote_url` with current remote refs:
/// clone when it is absent, fetch with `--prune` otherwise.
///
/// A clone is written to a sibling temporary directory and renamed into place
/// only on success, so an interrupted clone (cancel, restart, full disk) never
/// leaves a half-written directory where the main checkout belongs.
pub async fn ensure(
    ctx: &NetworkContext<'_>,
    remote_url: &str,
    main_path: &Path,
    on_phase: &(dyn Fn(Phase) + Send + Sync),
) -> Result<(), WorkspaceGitError> {
    let (Some(parent), Some(name)) = (
        main_path.parent(),
        main_path.file_name().and_then(|name| name.to_str()),
    ) else {
        return Err(WorkspaceGitError::invalid("invalid main checkout path"));
    };
    fs::create_dir_all(parent)?;
    check_git(ctx.git, parent).await?;
    let _lock = repo_lock::lock(&common_dir(main_path)).await;
    remove_leftover_clones(parent, name)?;
    match fs::symlink_metadata(main_path) {
        Ok(metadata) if metadata.is_dir() => {
            on_phase(Phase::Fetching);
            let args = ["fetch", "--progress", "--prune", "--", "origin"];
            run(ctx, main_path, "fetch", &args, FETCH_TIMEOUT).await
        }
        // A link or a file where the checkout belongs is never followed.
        Ok(_) => Err(WorkspaceGitError::failed(
            "the main checkout path exists and is not a directory",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            on_phase(Phase::Cloning);
            clone(ctx, remote_url, parent, name, main_path).await
        }
        Err(error) => Err(error.into()),
    }
}

async fn clone(
    ctx: &NetworkContext<'_>,
    remote_url: &str,
    parent: &Path,
    name: &str,
    main_path: &Path,
) -> Result<(), WorkspaceGitError> {
    let temporary = TemporaryClone::new(parent, name);
    let Some(target) = temporary.path.to_str() else {
        return Err(WorkspaceGitError::invalid("invalid main checkout path"));
    };
    let args = [
        "clone",
        "--progress",
        "--origin",
        "origin",
        "--",
        remote_url,
        target,
    ];
    run(ctx, parent, "clone", &args, CLONE_TIMEOUT).await?;
    fs::rename(&temporary.path, main_path)?;
    temporary.keep();
    Ok(())
}

/// Run one network command and map a failure to a stable code.
pub(super) async fn run(
    ctx: &NetworkContext<'_>,
    dir: &Path,
    step: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(), WorkspaceGitError> {
    let output = ctx
        .git
        .run_network_with_progress(dir, ctx.config, args, timeout, |line| {
            if let (Some(on_progress), Some(progress)) = (ctx.on_progress, parse_git_progress(line))
            {
                on_progress(progress);
            }
        })
        .await
        .map_err(|error| from_git_error(step, error))?;
    if output.status == 0 {
        Ok(())
    } else {
        Err(classify(ctx.config, step, &output))
    }
}

/// `WORKSPACE_GIT_UNAVAILABLE` unless a new enough git can be started.
pub async fn check_git(git: &GitRunner, dir: &Path) -> Result<(), WorkspaceGitError> {
    let version = git
        .run(dir, &["--version"])
        .await
        .map_err(|error| from_git_error("version", error))?;
    match parse_version(&version) {
        Some(found) if found < MIN_GIT_VERSION => Err(WorkspaceGitError::new(
            "WORKSPACE_GIT_UNAVAILABLE",
            format!(
                "git {}.{} is older than the required {}.{}",
                found.0, found.1, MIN_GIT_VERSION.0, MIN_GIT_VERSION.1
            ),
        )),
        _ => Ok(()),
    }
}

/// A git command that could not run to completion at all.
pub(super) fn from_git_error(step: &str, error: GitError) -> WorkspaceGitError {
    match error {
        GitError::Missing => WorkspaceGitError::new(
            "WORKSPACE_GIT_UNAVAILABLE",
            "git is not installed on this host",
        ),
        GitError::Timeout { secs, .. } => {
            WorkspaceGitError::failed(format!("git {step} timed out after {secs}s"))
        }
        GitError::Spawn(error) => {
            WorkspaceGitError::failed(format!("git {step} could not be started: {error}"))
        }
        GitError::Failed { stderr, .. } => {
            WorkspaceGitError::failed(format!("git {step} failed: {}", tail(&stderr)))
        }
    }
}

/// Map a failed git command to a stable code. The message keeps the last
/// 2 KiB of git's output, with the proxy address rewritten back to the GitHub
/// URL it stands for: the handle in it is not for logs or the desktop.
pub(super) fn classify(
    config: &[(&str, &str)],
    step: &str,
    output: &GitOutput,
) -> WorkspaceGitError {
    let stderr = redact(config, output.stderr.trim());
    let lower = stderr.to_ascii_lowercase();
    let contains_any = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    let code = if contains_any(&[
        "returned error: 401",
        "returned error: 403",
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission to ",
    ]) {
        "WORKSPACE_GIT_AUTH_REQUIRED"
    } else if contains_any(&[
        "repository not found",
        "does not appear to be a git repository",
    ]) || (lower.contains("fatal: repository '") && lower.contains("' not found"))
    {
        "WORKSPACE_GIT_REPOSITORY_NOT_FOUND"
    } else {
        "WORKSPACE_GIT_FAILED"
    };
    WorkspaceGitError::new(code, format!("git {step} failed: {}", tail(&stderr)))
}

/// Replace every proxy address named by a `url.<proxy>.insteadOf` pair with
/// the URL it rewrites.
fn redact(config: &[(&str, &str)], text: &str) -> String {
    let mut text = text.to_string();
    for (key, value) in config {
        let Some(proxy) = key
            .strip_prefix("url.")
            .and_then(|rest| rest.strip_suffix(".insteadOf"))
        else {
            continue;
        };
        text = text.replace(proxy, value);
        // The same handle with another path under it.
        if let Some((origin, path)) = split_origin(value) {
            if let Some(base) = proxy.strip_suffix(path) {
                text = text.replace(base, origin);
            }
        }
    }
    text
}

/// `https://host/a/b` into (`https://host/`, `a/b`).
fn split_origin(url: &str) -> Option<(&str, &str)> {
    let after_scheme = url.find("://")? + 3;
    let slash = after_scheme + url[after_scheme..].find('/')? + 1;
    Some((&url[..slash], &url[slash..]))
}

fn tail(text: &str) -> &str {
    if text.len() <= STDERR_TAIL_BYTES {
        return text;
    }
    let mut start = text.len() - STDERR_TAIL_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Temporary clones are named `<repo>.cloning-<random>.git`. No repository
/// name may end in `.git`, so the name can never be another repository's main
/// checkout in the same owner directory.
const TEMPORARY_SUFFIX: &str = ".git";

fn temporary_prefix(name: &str) -> String {
    format!("{name}.cloning-")
}

/// Remove what an interrupted clone of this repository left behind.
fn remove_leftover_clones(parent: &Path, name: &str) -> Result<(), WorkspaceGitError> {
    let prefix = temporary_prefix(name);
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with(&prefix) && file_name.ends_with(TEMPORARY_SUFFIX) {
            remove_path(&entry.path())?;
        }
    }
    Ok(())
}

/// Remove a directory tree, or a link or file as itself (never its target).
fn remove_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// The directory a clone is written to until it succeeds. Dropping it (a
/// failed clone, or a cancelled job whose future is dropped) removes it.
struct TemporaryClone {
    path: PathBuf,
    keep: bool,
}

impl TemporaryClone {
    fn new(parent: &Path, name: &str) -> Self {
        let random = uuid::Uuid::new_v4().simple().to_string();
        Self {
            path: parent.join(format!(
                "{}{random}{TEMPORARY_SUFFIX}",
                temporary_prefix(name)
            )),
            keep: false,
        }
    }

    fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for TemporaryClone {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        // Best effort: a git child that outlives its killed parent may still
        // be writing; whatever remains is removed by the next `ensure`.
        if let Err(error) = remove_path(&self.path) {
            tracing::warn!(%error, "could not remove an interrupted clone directory");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::workspace_git::test_support::{rev_parse, Remote};

    fn context(git: &GitRunner) -> NetworkContext<'_> {
        NetworkContext {
            git,
            config: &[],
            on_progress: None,
        }
    }

    #[tokio::test]
    async fn the_first_ensure_clones_and_the_second_fetches() {
        let dir = tempfile::tempdir().unwrap();
        let remote = Remote::new(dir.path());
        let main_path = dir.path().join("root/repos/github.com/octo/repo");
        let git = GitRunner::default();
        let phases = Mutex::new(Vec::new());
        let on_phase = |phase: Phase| phases.lock().unwrap().push(phase);

        ensure(&context(&git), &remote.url(), &main_path, &on_phase)
            .await
            .unwrap();
        assert_eq!(*phases.lock().unwrap(), [Phase::Cloning]);
        assert!(main_path.join(".git").is_dir());
        assert!(main_path.join("README.md").is_file());
        assert_eq!(
            rev_parse(&main_path, "refs/remotes/origin/main"),
            remote.head("main")
        );
        assert_eq!(
            rev_parse(&main_path, "refs/remotes/origin/develop"),
            remote.head("develop")
        );
        // The stored remote is the URL that was asked for, nothing else.
        assert_eq!(
            crate::session_worktrees::test_support::git_cmd(
                &main_path,
                &["config", "--get", "remote.origin.url"]
            )
            .trim(),
            remote.url()
        );

        let added = remote.commit("main", "later.txt", "later\n");
        assert_ne!(rev_parse(&main_path, "refs/remotes/origin/main"), added);
        ensure(&context(&git), &remote.url(), &main_path, &on_phase)
            .await
            .unwrap();
        assert_eq!(*phases.lock().unwrap(), [Phase::Cloning, Phase::Fetching]);
        assert_eq!(rev_parse(&main_path, "refs/remotes/origin/main"), added);
    }

    #[tokio::test]
    async fn a_leftover_clone_directory_is_cleared_and_does_not_block_ensure() {
        let dir = tempfile::tempdir().unwrap();
        let remote = Remote::new(dir.path());
        let parent = dir.path().join("root/repos/github.com/octo");
        let main_path = parent.join("repo");
        // An earlier clone was interrupted: it left a half-written directory.
        let leftover = parent.join("repo.cloning-0123abcd.git");
        std::fs::create_dir_all(leftover.join(".git/objects")).unwrap();
        std::fs::write(leftover.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        // `repo.cloning-tools` is a legal repository name: a sibling main
        // checkout must never be mistaken for a leftover. Temporary clones end
        // in `.git`, which no repository name may.
        let sibling = parent.join("repo.cloning-tools");
        std::fs::create_dir_all(sibling.join(".git")).unwrap();
        let other = parent.join("repository.cloning-0123abcd.git");
        std::fs::create_dir_all(&other).unwrap();

        let git = GitRunner::default();
        ensure(&context(&git), &remote.url(), &main_path, &|_| {})
            .await
            .unwrap();
        assert!(main_path.join(".git").is_dir());
        assert!(!leftover.exists());
        assert!(other.exists());
        let names: Vec<String> = std::fs::read_dir(&parent)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("repo.cloning-"))
            .collect();
        assert_eq!(names, ["repo.cloning-tools"]);
        assert!(sibling.join(".git").is_dir());
    }

    #[tokio::test]
    async fn a_failed_clone_leaves_nothing_where_the_main_checkout_belongs() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("root/repos/github.com/octo");
        let main_path = parent.join("repo");
        let git = GitRunner::default();
        let missing = format!("file://{}", dir.path().join("no-such.git").display());
        let error = ensure(&context(&git), &missing, &main_path, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_REPOSITORY_NOT_FOUND", "{error}");
        assert!(!main_path.exists());
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
        // The next attempt against a real remote succeeds.
        let remote = Remote::new(dir.path());
        ensure(&context(&git), &remote.url(), &main_path, &|_| {})
            .await
            .unwrap();
        assert!(main_path.join(".git").is_dir());
    }

    #[tokio::test]
    async fn a_path_that_is_not_a_directory_is_never_used_as_the_main_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let remote = Remote::new(dir.path());
        let parent = dir.path().join("root/repos/github.com/octo");
        std::fs::create_dir_all(&parent).unwrap();
        let main_path = parent.join("repo");
        std::fs::write(&main_path, "not a repository").unwrap();
        let git = GitRunner::default();
        let error = ensure(&context(&git), &remote.url(), &main_path, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_FAILED");
        assert_eq!(
            std::fs::read_to_string(&main_path).unwrap(),
            "not a repository"
        );
    }

    #[cfg(unix)]
    fn stub_git(dir: &Path, body: &str) -> GitRunner {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("git-stub");
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        GitRunner::with_program(script)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_missing_or_old_git_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let main_path = dir.path().join("root/repos/github.com/octo/repo");
        let missing = GitRunner::with_program(dir.path().join("no-such-git"));
        let error = ensure(&context(&missing), "file:///x", &main_path, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_UNAVAILABLE");
        // Environment-carried configuration, which carries the proxy rewrite,
        // exists from git 2.31.
        let old = stub_git(dir.path(), "echo 'git version 2.30.2'");
        let error = ensure(&context(&old), "file:///x", &main_path, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_UNAVAILABLE");
        assert!(error.message.contains("2.31"), "{error}");
        assert!(!main_path.exists());
    }

    fn failed(stderr: &str) -> GitOutput {
        GitOutput {
            status: 128,
            stdout: String::new(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn git_failures_map_to_stable_codes() {
        let none: &[(&str, &str)] = &[];
        for stderr in [
            "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 401",
            "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
            "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
            "fatal: could not read Username for 'http://127.0.0.1:1': terminal prompts disabled",
            "remote: Permission to o/r.git denied to someone.",
        ] {
            assert_eq!(
                classify(none, "clone", &failed(stderr)).code,
                "WORKSPACE_GIT_AUTH_REQUIRED",
                "{stderr}"
            );
        }
        for stderr in [
            "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
            "fatal: repository 'https://github.com/o/r.git/' not found",
            "fatal: '/tmp/x.git' does not appear to be a git repository",
        ] {
            assert_eq!(
                classify(none, "clone", &failed(stderr)).code,
                "WORKSPACE_GIT_REPOSITORY_NOT_FOUND",
                "{stderr}"
            );
        }
        let other = classify(
            none,
            "fetch",
            &failed("fatal: the remote end hung up unexpectedly"),
        );
        assert_eq!(other.code, "WORKSPACE_GIT_FAILED");
        assert!(other.message.contains("hung up"));
    }

    #[test]
    fn failure_messages_keep_the_tail_and_never_the_proxy_handle() {
        let handle = "ab".repeat(32);
        let key = format!("url.http://127.0.0.1:4321/{handle}/o/r.git.insteadOf");
        let config = [(key.as_str(), "https://github.com/o/r.git")];
        let stderr = format!(
            "{}\nfatal: unable to access 'http://127.0.0.1:4321/{handle}/o/r.git/': boom\nerror: see http://127.0.0.1:4321/{handle}/other/x.git\n",
            "x".repeat(8 * 1024)
        );
        let error = classify(&config, "fetch", &failed(&stderr));
        assert_eq!(error.code, "WORKSPACE_GIT_FAILED");
        assert!(!error.message.contains(&handle), "{}", error.message);
        assert!(!error.message.contains("127.0.0.1:4321"));
        assert!(error
            .message
            .contains("unable to access 'https://github.com/o/r.git/': boom"));
        assert!(error.message.contains("https://github.com/other/x.git"));
        // Only the last 2 KiB of output is kept.
        assert!(
            error.message.len() <= 2 * 1024 + 256,
            "{}",
            error.message.len()
        );
    }

    #[test]
    fn parse_git_progress_extracts_known_phases_and_ignores_arbitrary_stderr() {
        assert_eq!(
            parse_git_progress("Receiving objects:  42% (10/24)"),
            Some(JobProgress {
                percent: Some(42),
                detail: Some("Receiving objects".into()),
            })
        );
        assert_eq!(
            parse_git_progress("remote: Compressing objects: 100% (5/5), done."),
            Some(JobProgress {
                percent: Some(100),
                detail: Some("Compressing objects".into()),
            })
        );
        assert_eq!(
            parse_git_progress("Writing objects:  75%"),
            Some(JobProgress {
                percent: Some(75),
                detail: Some("Writing objects".into()),
            })
        );
        assert_eq!(
            parse_git_progress("remote: Enumerating objects: 18, done."),
            Some(JobProgress {
                percent: None,
                detail: Some("Enumerating objects".into()),
            })
        );
        assert_eq!(parse_git_progress("Receiving objects: 101% (10/10)"), None);
        assert_eq!(
            parse_git_progress("Cloning into 'http://127.0.0.1:4321/secret-handle/o/r.git'..."),
            None
        );
        assert_eq!(
            parse_git_progress("remote: Receiving objects: http://127.0.0.1:4321/secret"),
            None
        );
    }

    #[tokio::test]
    async fn clone_emits_parsed_progress_events() {
        let dir = tempfile::tempdir().unwrap();
        let remote = Remote::new(dir.path());
        let main_path = dir.path().join("root/repos/github.com/octo/repo");
        let git = GitRunner::default();
        let progress = Mutex::new(Vec::new());
        let on_progress = |item: JobProgress| progress.lock().unwrap().push(item);
        let ctx = NetworkContext {
            git: &git,
            config: &[],
            on_progress: Some(&on_progress),
        };
        ensure(&ctx, &remote.url(), &main_path, &|_| {})
            .await
            .unwrap();
        let events = progress.lock().unwrap();
        assert!(!events.is_empty(), "expected clone --progress output");
        assert!(
            events.iter().any(|item| item.percent.is_some()),
            "expected at least one percentage progress event: {events:?}"
        );
    }
}
